/**
 * `HocuspocusSync` — Hocuspocus-backed write-path closure for
 * `SyncService.transact` (architecture.md §6.1 / ADR 0018 F31).
 *
 * Composition:
 *
 *   1. Dispatcher's `runInWriteTx` opens a SQL tx via
 *      `withSystemTx(setIsolationLevel("serializable") → BEGIN IMMEDIATE)`.
 *   2. Dispatcher calls `hocuspocusSync.bind({ sqlTx, principal,
 *      workspace_id })` to get a per-invocation `BoundSyncService` whose
 *      `transact` closes over the tx handle. The bound service tracks
 *      every `doc_id` mutated so `runInWriteTx` can drop those Y.Docs
 *      from memory via `bound.rollback()` if the closure throws.
 *   3. Capability handler calls `ctx.transact(doc_id, fn)` — routes to
 *      `server.openDirectConnection(doc_id).transact(callback)`.
 *   4. On the first open of a `doc_id`, Hocuspocus fires
 *      `onLoadDocument`. The hook reads every committed `doc_updates`
 *      row for the doc via `DocUpdatesReader` and applies them in
 *      `seq` order to the Document — the hot Y.Doc is now caught up
 *      to durable state before the handler mutates it.
 *   5. Inside the callback we subscribe to the Y.Doc's `update` event,
 *      run the handler's `fn`, unsubscribe. The captured update deltas
 *      are merged (`Y.mergeUpdates`) into a single blob.
 *   6. After `transact` returns, we hand the blob off to the injected
 *      `DocUpdatesWriter` which INSERTs `doc_updates` + `outbox(doc.updated)`
 *      through the SAME sql tx.
 *   7. If the outer tx rolls back, `runInWriteTx` calls
 *      `bound.rollback()` which closes every per-invocation
 *      `DirectConnection` for the mutated `doc_id`s. The last
 *      disconnect drives Hocuspocus's `shouldUnloadDocument` to true
 *      and the Y.Doc is dropped from memory. The next `ctx.transact`
 *      re-opens via `onLoadDocument`, which replays only committed
 *      `doc_updates` — the aborted mutation is gone from both SQL and
 *      in-memory CRDT state.
 *
 * Result: `docs` INSERT + `doc_updates` + `outbox(doc.updated)` +
 * `audit_events` + `outbox(audit.appended)` commit together or not at
 * all. Handler throw rolls all five SQL rows back; the in-memory
 * Y.Doc is dropped when this `HocuspocusSync` is the only connection
 * holder (see "In-memory rollback scope" below). Invariant 7 closes
 * end-to-end for the durable SQL tuple, and for in-memory state in
 * the single-process-no-websocket-clients configuration that Phase 3
 * verifies.
 *
 * **In-memory rollback scope — WebSocket clients.** `bound.rollback()`
 * disconnects every per-invocation `DirectConnection` this binding
 * holds for a mutated doc. Hocuspocus's `shouldUnloadDocument` gates
 * the actual Y.Doc unload on `getConnectionsCount() === 0`, and that
 * count includes WebSocket client connections, not just our direct
 * ones. In a deployment with live browser editors attached to the
 * same doc, rolling back a server-side `ctx.transact` does not evict
 * the Document from memory — the rolled-back mutation stays resident
 * and a subsequent `ctx.transact` reads the polluted state.
 *
 * A stronger fix would buffer the update broadcast until the SQL tx
 * commits and only then replay to clients; the rolled-back case would
 * drop the buffer instead of broadcasting. Broadcasting first + trying
 * to unbroadcast after rollback is fundamentally incorrect — clients
 * applying the aborted delta locally would re-send it on reconnect
 * and the CRDT would re-merge it. That design change is Phase 4 scope
 * (production hardening); P3.6e's rollback handles the single-writer
 * path the dispatcher exercises in tests, and the integration test
 * assumes no parallel WebSocket session on the mutated doc.
 *
 * **Why capture updates via `Y.Doc#on("update", …)` rather than via
 * Hocuspocus's `onChange` hook.** `onChange` is fire-and-forget in
 * 3.4.x (verified at `Hocuspocus.ts:265`); relying on it would have to
 * stash state in a `WeakMap<Document, Uint8Array[]>` and race against
 * the post-transact persist. Subscribing to the Y.Doc event inside the
 * `transact` closure keeps the capture, transform, and persist in one
 * linear async block. No state leaks between invocations.
 *
 * **Why not persist inside Hocuspocus's `onStoreDocument` hook.** The
 * hook runs under `saveMutex`, which is the per-doc lock Hocuspocus
 * uses to serialise stores. If we persisted there, we'd be holding the
 * saveMutex for the duration of the SQL tx — acceptable for the
 * write-path mutation, but conflates "update-side persistence" with
 * "snapshot-side compaction". `onStoreDocument` stays dedicated to the
 * compaction path (writes `doc_snapshots`, lands in a later slice).
 * Update-side persistence happens here in `transact`, directly against
 * the injected writer + tx.
 *
 * **Why `onLoadDocument` (and not a lazy hydrate on first mutation).**
 * Hocuspocus's `onLoadDocument` is the only hook that fires *before*
 * the Document is returned to the caller of `openDirectConnection`.
 * Hydrating on first mutation inside `#runTransactLocked` would race
 * against background read paths that open the same doc (a future
 * `ctx.read` on the Y.Doc, `doc.export` that reads across many docs).
 * Pinning hydration to the hook keeps every code path that gets a
 * `Document` reference synchronised with durable state.
 *
 * **Test-shape composition.** `new Hocuspocus(...)` without `listen()`
 * works headless — the research pass and the `Hocuspocus.d.ts`
 * surface both confirm. No WebSocket, no HTTP server. We set
 * `debounce: 0` + `unloadImmediately: false` so `onStoreDocument`
 * doesn't fire on its own (we're not using it), and docs don't unload
 * between invocations unless `bound.rollback()` explicitly drops them.
 */

import type { AuditTx } from "@editorzero/audit";
import type { DocUpdatesReader, DocUpdatesWriter, SystemDb } from "@editorzero/db";
import type { DocId, WorkspaceId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import type { BoundSyncService } from "./service";

/**
 * Per-invocation context the dispatcher wiring closes over at
 * `bind()` time. Carries the tx handle + principal + workspace_id
 * the `DocUpdatesWriter` needs when it writes `doc_updates` +
 * `outbox(doc.updated)`.
 *
 * `workspace_id` is passed explicitly (not derived from `principal`)
 * because the dispatcher has already cross-checked F86 at entry —
 * `access.workspace_id === principal.workspace_id` — and passing a
 * freshly-derived value here avoids re-deriving inside sync.
 */
export interface HocuspocusTxContext {
  readonly sqlTx: AuditTx;
  readonly principal: Principal;
  readonly workspace_id: WorkspaceId;
}

export interface HocuspocusSyncDeps {
  readonly docUpdatesWriter: DocUpdatesWriter;
  /**
   * Dispatches between two shapes from its call site inside the
   * `onLoadDocument` hook — `readByDoc(auditTx, doc_id)` on the
   * write-path (shares the enclosing SQL tx), and
   * `readByDocUntransacted(systemDb, doc_id)` on the read-path
   * (untransacted, no RESERVED lock). Both return committed state
   * only (see `doc-updates-reader.ts` docstring).
   */
  readonly docUpdatesReader: DocUpdatesReader;
  /**
   * Untransacted `Kysely<SystemDatabase>` handle, supplied by the
   * composition root via `driver.system()`. Consumed by the
   * `onLoadDocument` hook on the read-path (when `HocuspocusSync.read`
   * opens a doc without a SQL tx): hydration reads committed
   * `doc_updates` via `docUpdatesReader.readByDocUntransacted(systemDb,
   * doc_id)`. WAL on SQLite + the Postgres pool both let this run
   * concurrently with live writers.
   */
  readonly systemDb: SystemDb;
  /**
   * Optional hocuspocus tuning. Defaults are test-safe: `debounce: 0`
   * + `unloadImmediately: false` keep `onStoreDocument` from firing
   * and docs resident across invocations. Production wiring will
   * override with real values + a compaction hook.
   */
  readonly hocuspocus?: {
    readonly debounce?: number;
    readonly unloadImmediately?: boolean;
    readonly name?: string;
  };
}

/**
 * Internal marker for read-path opens (`HocuspocusSync.read` passes
 * this as the `openDirectConnection` context). The hydration hook
 * branches on presence of `__read` to route through the untransacted
 * reader. Not exported — read callers don't construct this directly;
 * they go through `HocuspocusSync.read(doc_id, fn)`.
 *
 * Kept out of the `HocuspocusTxContext` union because Codex's read-
 * seam review called out "don't couple the read API to the write-
 * bind context shape" — the read path has no principal / workspace_id
 * need (no `doc_updates` attribution), and widening the exported
 * type would force read callers to invent values.
 */
interface HocuspocusReadMarker {
  readonly __read: true;
}

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

export class HocuspocusSync {
  readonly #server: Hocuspocus;
  readonly #docUpdatesWriter: DocUpdatesWriter;
  /**
   * Singleton `DirectConnection` per `doc_id`. Each `#runTransactLocked`
   * opens a fresh connection (carrying the current invocation's
   * context — `storeDocumentHooks` reads `this.context` off the
   * DirectConnection, so stale contexts would bleed into future
   * compaction-hook payloads), then replaces the map entry and
   * disconnects the previous one in `finally`. The overlap keeps
   * `directConnectionsCount >= 1` across the swap, so Hocuspocus's
   * `shouldUnloadDocument` never fires between invocations — the
   * Y.Doc stays resident without paying hydration cost per call
   * (§6.4 assumes hot docs stay in memory under burst writes).
   *
   * Bounded memory: O(1) direct connections per doc regardless of
   * invocation count, closing the "O(invocations) retention" leak
   * from the pre-P3.6e shape (Codex adversarial review).
   *
   * **Rollback interaction.** `BoundSyncService.rollback()` calls
   * `#dropInMemory(doc_id)` which disconnects the current map entry.
   * Because `#withDocLock` serialises same-doc transacts AND the
   * dispatcher's SQL tx serialises same-workspace writers, rollback
   * fires after all in-flight work on this doc has finished — no
   * other binding is mid-transact on it. Disconnecting the singleton
   * drops the last direct holder, so if no WebSocket clients are
   * attached `shouldUnloadDocument` fires and the next `ctx.transact`
   * re-hydrates through `onLoadDocument`. See class docstring
   * "In-memory rollback scope" for the WebSocket-client limit.
   */
  readonly #liveConnections: Map<DocId, DirectConnection> = new Map();
  /**
   * Per-doc async mutex (closes Codex P3.6c adversarial P1).
   *
   * `DirectConnection.transact()` in Hocuspocus 3.4.4 does not serialise
   * the mutation phase — only the subsequent `storeDocumentHooks` call
   * is under `saveMutex`. Two concurrent `transact` invocations on the
   * same doc therefore run their callback bodies back-to-back on the
   * shared Y.Doc, and our `document.on("update", …)` listener (which
   * must span the full `fn` Promise to satisfy `SyncService.transact`'s
   * async contract) would capture the other invocation's deltas —
   * durably persisting them under the wrong principal + seq.
   *
   * A per-doc mutex chain serialises the whole `open → mutate → capture
   * → persist` sequence so that, at the sync layer, only one invocation
   * is inside `transact` on a given doc at a time. The chain stores
   * "error-swallowing" tails so a throwing handler doesn't poison
   * subsequent waiters.
   *
   * SQLite's single-connection serialisation already funnels `withSystemTx`
   * calls end-to-end, so the mutex is belt-and-suspenders there; for
   * Postgres (ADR 0007), where `withSystemTx` runs on independent
   * connections, the mutex is load-bearing.
   */
  readonly #docLocks: Map<DocId, Promise<void>> = new Map();
  #closed = false;

  constructor(deps: HocuspocusSyncDeps) {
    this.#docUpdatesWriter = deps.docUpdatesWriter;
    const reader = deps.docUpdatesReader;
    const systemDb = deps.systemDb;
    // `unloadImmediately: false` keeps Y.Docs resident across the
    // per-doc `debounce` window after the last direct connection
    // drops (§6.4 assumes hot docs stay in memory under burst writes).
    // We inherit Hocuspocus's own `debounce: 2000` default rather than
    // forcing 0 — forcing 0 causes the `onStoreDocument` debouncer to
    // flush immediately on disconnect, whereupon `shouldUnloadDocument`
    // returns true and the doc drops out of memory between successive
    // `ctx.transact` calls in the same test. Our `onStoreDocument` is
    // unregistered; the compaction path lands in a later slice.
    this.#server = new Hocuspocus({
      name: deps.hocuspocus?.name ?? "editorzero",
      ...(deps.hocuspocus?.debounce !== undefined && { debounce: deps.hocuspocus.debounce }),
      unloadImmediately: deps.hocuspocus?.unloadImmediately ?? false,
      quiet: true,
      extensions: [],
      // Hydration: the Document passed in is the server's canonical
      // Y.Doc instance for this documentName. Applying updates
      // directly to it is what Hocuspocus itself would do if we
      // returned a throwaway Y.Doc from the hook and let it
      // `encodeStateAsUpdate` + `applyUpdate` in a second round-trip
      // (verified at `Hocuspocus.esm.js:2458-2466`). Writing to the
      // canonical instance skips the extra encode/decode.
      //
      // **Three-way dispatch on `context`.**
      //
      //   1. Write-path bind — `context.sqlTx` set (+ `principal` +
      //      `workspace_id`). Read through that tx's handle via
      //      `reader.readByDoc(sqlTx, …)`. Sharing the handle is
      //      load-bearing on SQLite: better-sqlite3 has one connection,
      //      and a separate `driver.system()` read would deadlock
      //      waiting for the tx to commit (see `doc-updates-reader.ts`).
      //      Read-your-own-writes is not a concern — the writer runs
      //      *after* the handler's CRDT mutation, so no `doc_updates`
      //      row for this doc exists in the tx yet.
      //   2. Read-path — `context.__read === true` (internal marker set
      //      by `HocuspocusSync.read`). No SQL tx; hydrate via
      //      `reader.readByDocUntransacted(systemDb, …)` on the captured
      //      untransacted handle. SQLite's WAL + Postgres's pool both
      //      tolerate this running concurrently with live writers.
      //   3. Non-bind, non-read opens (today: test fixtures simulating
      //      a concurrent connection holder; Phase 4: WebSocket client
      //      loads). Skip hydration. The Phase 4 WebSocket path will
      //      open with its own hydration marker; for Phase 3 the two
      //      sanctioned openers (`bind().transact` + `read`) are the
      //      only paths that need it.
      //
      // Throwing out of the hook causes Hocuspocus to
      // `unloadDocument` + `closeConnections` + rethrow — the
      // `openDirectConnection` promise will reject, surfacing the
      // replay failure to the caller rather than loading a
      // partially-hydrated Y.Doc.
      onLoadDocument: async ({ document, documentName, context }) => {
        const maybeCtx = context as
          | (Partial<HocuspocusTxContext> & Partial<HocuspocusReadMarker>)
          | null
          | undefined;
        const sqlTx = maybeCtx?.sqlTx;
        if (sqlTx !== undefined) {
          const blobs = await reader.readByDoc(sqlTx, documentName as DocId);
          for (const blob of blobs) {
            Y.applyUpdate(document, blob);
          }
          return;
        }
        if (maybeCtx?.__read === true) {
          const blobs = await reader.readByDocUntransacted(systemDb, documentName as DocId);
          for (const blob of blobs) {
            Y.applyUpdate(document, blob);
          }
          return;
        }
      },
    });
  }

  /**
   * Return a `BoundSyncService` whose `transact` routes through the
   * shared `Hocuspocus` instance and closes over `context` so
   * `DocUpdatesWriter.write(context.sqlTx, …)` commits inside the
   * dispatcher's open SQL transaction. One `HocuspocusSync` per
   * process; one `bind` per dispatcher invocation.
   *
   * The binding tracks every `doc_id` touched by its `transact`. The
   * dispatcher's `runInWriteTx` calls `bound.rollback()` in its catch
   * path — that drops the tracked docs from memory so the next
   * `ctx.transact` rehydrates from committed `doc_updates`.
   *
   * The returned service's `close()` is a no-op — the underlying
   * Hocuspocus instance is process-scoped and closed via
   * `HocuspocusSync.close()`, not via a per-invocation handle. The
   * dispatcher must never call `close()` on a bound service.
   */
  bind(context: HocuspocusTxContext): BoundSyncService {
    const mutated = new Set<DocId>();
    return {
      transact: <T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T> => {
        mutated.add(doc_id);
        return this.#runTransact(context, doc_id, fn);
      },
      rollback: async () => {
        // Iterate a snapshot so `#dropInMemory` can mutate the set if
        // we ever extend it to re-enqueue partial failures. Today the
        // only mutation is the `mutated.clear()` at the end, which
        // runs after the loop.
        for (const doc_id of Array.from(mutated)) {
          await this.#dropInMemory(doc_id);
        }
        mutated.clear();
      },
      close: async () => {
        /* no-op — see class docstring */
      },
    };
  }

  /**
   * Tx-less read-path Y.Doc opener (§6.4 — "reads must not take the
   * RESERVED lock `BEGIN IMMEDIATE` grabs"). Runs `fn` against a
   * **throwaway clone** of the current live Y.Doc for `doc_id`,
   * without opening a SQL write tx.
   *
   * Serialises against concurrent `bind().transact` on the same doc
   * via `#withDocLock` — the per-doc mutex orders reads and writes
   * on a given doc even though reads don't open a SQL tx, so a read
   * never observes a half-mutated Y.Doc mid-`transact`.
   *
   * **Clone-before-fn (Codex Slice-1 finding — contamination guard).**
   * The earlier shape handed `fn` the live resident Y.Doc. A
   * misbehaving handler (`sync.read(doc, y => y.getText("body")
   * .insert(0, "ghost"))`) dirtied in-memory state with no
   * `doc_updates` row — the read path registers no `update` listener,
   * so the mutation didn't persist, but it *did* stay resident.
   * Subsequent reads saw the polluted text; worse, a later
   * `bind().transact` captured its delta relative to the polluted
   * state, committed a row that replayed cleanly from cold hydration
   * but diverged from the hot Y.Doc. Cold vs. hot disagreement is
   * exactly the class of bug the invariant-7 atomicity machinery is
   * supposed to prevent. The fix: snapshot the live doc under the
   * mutex via `Y.encodeStateAsUpdate`, materialise a fresh throwaway
   * `Y.Doc` from that snapshot, hand the throwaway to `fn`, destroy
   * it in `finally`. Handler mutations touch only the clone; the
   * resident doc stays identical to committed state + any in-flight
   * writer's applied updates.
   *
   * **No principal / workspace_id.** Reads don't attribute
   * `doc_updates` rows or mint audit entries; the read API stays
   * narrower than the write-bind context so callers can't
   * accidentally thread mismatched identity through a read path.
   * Codex's Slice-1 review flagged this too — widening later (when a
   * kernel-split `ctx.readDoc` lands — Phase 3.7+) is cheap;
   * narrowing later is a breaking change.
   *
   * **Cost.** `Y.encodeStateAsUpdate` + `Y.applyUpdate` on a clone
   * per read call is O(doc state). Undo/redo history is not
   * preserved on the clone (Yjs `encodeStateAsUpdate` is
   * state-only) — acceptable because the read path has no
   * undo/redo semantics anyway. Callers must read plain data out of
   * the clone inside `fn`; Y types returned after `clone.destroy()`
   * have undefined behaviour.
   *
   * **Visibility gap on commit-in-flight writes (acknowledged).**
   * The mutex orders reads after any in-flight `bind().transact`
   * body has fully returned, but the outer SQL tx may not have
   * committed yet. A read's clone can therefore carry Y.Doc
   * mutations whose `doc_updates` row has not yet been visible to
   * other connections. If the outer tx subsequently rolls back,
   * `bound.rollback()` evicts the resident Y.Doc — but our read's
   * clone already returned. This is the Phase-4 broadcast-
   * suppression gap (class docstring "In-memory rollback scope");
   * Phase 3's single-writer tests tolerate the sub-millisecond
   * window.
   */
  async read<T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T> {
    return this.#withDocLock(doc_id, () => this.#runRead(doc_id, fn));
  }

  async #runRead<T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new Error("HocuspocusSync: read called after close()");
    }
    // Mirrors the open-replace pattern in `#runTransactLocked` — open
    // a fresh DirectConnection carrying *this invocation's* read marker,
    // register it as the per-doc singleton, disconnect the previous
    // holder in `finally` after the new one is stored so the Y.Doc
    // stays resident across the swap. If the doc was already hot (from
    // a prior transact or read), Hocuspocus reuses the existing
    // Document without re-firing `onLoadDocument`; the marker only
    // governs hydration on first load.
    const readMarker: HocuspocusReadMarker = { __read: true };
    const direct = await this.#server.openDirectConnection(doc_id, readMarker);
    const previous = this.#liveConnections.get(doc_id);
    this.#liveConnections.set(doc_id, direct);
    try {
      // Snapshot the live doc under the mutex. `direct.transact` is
      // the only documented way to get a Y.Doc reference off a
      // `DirectConnection` (3.4.4 source — the callback receives the
      // canonical `Document` instance). We read-only, no listener.
      let snapshot: Uint8Array | undefined;
      await direct.transact((liveDoc) => {
        snapshot = Y.encodeStateAsUpdate(liveDoc as unknown as Y.Doc);
      });
      if (snapshot === undefined) {
        throw new Error("HocuspocusSync: direct.transact did not yield a Y.Doc");
      }
      const clone = new Y.Doc();
      Y.applyUpdate(clone, snapshot);
      try {
        return await fn(clone);
      } finally {
        clone.destroy();
      }
    } finally {
      if (previous !== undefined && previous !== direct) {
        await previous.disconnect();
      }
    }
  }

  /**
   * @internal — test-only handle to the underlying Hocuspocus server.
   * Used by the adversarial-regression tests that need to assert
   * the per-doc `directConnectionsCount` matches the open-replace
   * pattern (bounded at 1) and to simulate a concurrent non-bind
   * connection holder (WebSocket client) for the rollback-scope-limit
   * regression guard. Not for production composition — the runtime
   * wires `HocuspocusSync` by its public `bind` / `close` surface.
   */
  _server_testOnly(): Hocuspocus {
    return this.#server;
  }

  /** Shut down Hocuspocus + release all resident Y.Docs. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Disconnect every per-doc singleton. `DirectConnection.disconnect`
    // flushes `onStoreDocument` via `storeDocumentHooks(immediately=true)`
    // and unloads the Y.Doc when the last connection drops (no WebSocket
    // clients in test/headless).
    const conns = Array.from(this.#liveConnections.values());
    this.#liveConnections.clear();
    for (const direct of conns) {
      await direct.disconnect();
    }
    this.#server.closeConnections();
  }

  /**
   * Chain-based per-doc mutex. The public `transact` path routes
   * through here so concurrent same-doc invocations queue. See
   * `#docLocks` for the rationale.
   */
  async #withDocLock<T>(doc_id: DocId, fn: () => Promise<T>): Promise<T> {
    const prev = this.#docLocks.get(doc_id) ?? Promise.resolve();
    const result: Promise<T> = prev.then(fn, fn);
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.#docLocks.set(doc_id, tail);
    try {
      return await result;
    } finally {
      if (this.#docLocks.get(doc_id) === tail) {
        this.#docLocks.delete(doc_id);
      }
    }
  }

  #runTransact<T>(
    context: HocuspocusTxContext,
    doc_id: DocId,
    fn: (ydoc: Y.Doc) => T | Promise<T>,
  ): Promise<T> {
    return this.#withDocLock(doc_id, () => this.#runTransactLocked(context, doc_id, fn));
  }

  async #runTransactLocked<T>(
    context: HocuspocusTxContext,
    doc_id: DocId,
    fn: (ydoc: Y.Doc) => T | Promise<T>,
  ): Promise<T> {
    if (this.#closed) {
      throw new Error("HocuspocusSync: transact called after close()");
    }

    // **Open-replace pattern for per-doc singleton retention.** Each
    // invocation opens a fresh `DirectConnection` carrying *this
    // invocation's* context (`storeDocumentHooks` later reads that
    // off the DirectConnection for the compaction-hook payload; a
    // reused connection would leak the previous invocation's context
    // into future hooks). We then replace the map entry and disconnect
    // the previous singleton in the `finally` block at the end of
    // this function.
    //
    // Because the new connection is in-place before we disconnect the
    // old one, Hocuspocus's `directConnectionsCount` never drops to
    // zero during the swap — `shouldUnloadDocument` stays false and
    // the Y.Doc remains resident across the transition. The next
    // `ctx.transact` therefore doesn't pay the `onLoadDocument`
    // hydration cost.
    //
    // `DirectConnection.disconnect` in Hocuspocus 3.4.4 unconditionally
    // triggers `unloadDocument` when the direct-connection count drops
    // to zero (source: `DirectConnection.disconnect` at line 2142 of
    // the built bundle, regardless of `unloadImmediately`). Without
    // the overlap, consecutive `ctx.transact` calls would each
    // rehydrate a fresh Y.Doc from committed `doc_updates` — correct
    // for durability but expensive under burst writes (§6.4 expects
    // hot docs to stay in memory).
    //
    // Bounded memory: one `DirectConnection` per doc at a time
    // regardless of invocation count (Codex P3.6e adversarial
    // review). The prior per-invocation `Set<DirectConnection>`
    // retained every connection until `HocuspocusSync.close()`, which
    // grew O(invocations) for long-lived servers.
    const direct = await this.#server.openDirectConnection(doc_id, context);
    const previous = this.#liveConnections.get(doc_id);
    this.#liveConnections.set(doc_id, direct);
    // `DirectConnection.transact` invokes our callback directly on the
    // Document (no Y.Doc.transact wrap — verified in Hocuspocus 3.4.4
    // source). Raw Y.Doc mutations inside the callback fire 'update'
    // events with `origin = null`; no stable origin value distinguishes
    // our updates from another writer's. The correctness argument is
    // topological: Hocuspocus's per-doc `saveMutex` + the per-process
    // loading-documents map mean only one writer is inside a `transact`
    // on this doc at a time. We collect every update fired while the
    // listener is attached.
    //
    // **Listener lifetime.** Per `SyncService.transact`'s contract, `fn`
    // may be async — "anything after an await is its own update." Post-
    // await mutations fire update events AFTER the sync-callback closure
    // returns, so `document.off` cannot live in the sync-callback's
    // `finally`; it must live outside, bracketing the full `fn` promise
    // resolution. We therefore subscribe inside the sync callback (as
    // soon as we hold a Y.Doc reference) and unsubscribe in a finally
    // around the outer `await` on `fn`'s Promise.
    const updates: Uint8Array[] = [];
    const captureUpdate = (update: Uint8Array, _origin: unknown): void => {
      updates.push(update);
    };
    let document: Y.Doc | undefined;
    let resultOrPromise: T | Promise<T> | undefined;
    let syncThrown: unknown;
    let didSyncThrow = false;

    try {
      await direct.transact((doc) => {
        document = doc as unknown as Y.Doc;
        document.on("update", captureUpdate);
        try {
          resultOrPromise = fn(document);
        } catch (e) {
          syncThrown = e;
          didSyncThrow = true;
        }
      });

      if (didSyncThrow) {
        document?.off("update", captureUpdate);
        throw syncThrown;
      }

      let finalResult: T;
      try {
        finalResult = (await (resultOrPromise as T | Promise<T>)) as T;
      } finally {
        document?.off("update", captureUpdate);
      }

      // Non-empty update set → persist. An empty set means the handler
      // called `ctx.transact` but issued no Y.Doc mutations — a no-op
      // path that should not produce a `doc_updates` row (seq would
      // advance for nothing).
      if (updates.length > 0) {
        const merged = Y.mergeUpdates(updates);
        await this.#docUpdatesWriter.write(context.sqlTx, {
          doc_id,
          workspace_id: context.workspace_id,
          update_blob: merged,
          principal: context.principal,
        });
      }

      return finalResult;
    } finally {
      // Disconnect the previous singleton AFTER the new one is stored
      // in the map (so the Y.Doc's connection count overlaps and it
      // stays resident through the swap). Runs on both the commit and
      // the throw paths — in either case, the new `direct` is the
      // holder, and `previous` is safe to release. On a mid-transact
      // throw the new `direct` is still in the map; a later
      // `bound.rollback()` disconnects it. Without this cleanup the
      // previous connection would leak (O(invocations) retention —
      // the exact Codex finding this fix closes).
      if (previous !== undefined && previous !== direct) {
        await previous.disconnect();
      }
    }
  }

  /**
   * Drop the in-memory Y.Doc for `doc_id` by disconnecting the current
   * per-doc singleton. When no WebSocket clients are attached,
   * Hocuspocus's `shouldUnloadDocument` fires on the disconnect and
   * the Document clears from memory — the next `ctx.transact` reopens
   * through `onLoadDocument`, replaying only committed `doc_updates`.
   *
   * When WebSocket clients ARE attached, `getConnectionsCount()`
   * stays positive after our direct connection disconnects and the
   * Document stays resident. See the class docstring's "In-memory
   * rollback scope" section — this is the Phase 4 gap that
   * broadcast-suppression closes; P3.6e's scope is the single-writer
   * path.
   *
   * Called only via `BoundSyncService.rollback()` — not part of the
   * transact path, not called on commit.
   */
  async #dropInMemory(doc_id: DocId): Promise<void> {
    const direct = this.#liveConnections.get(doc_id);
    if (direct === undefined) return;
    this.#liveConnections.delete(doc_id);
    await direct.disconnect();
  }
}
