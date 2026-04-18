/**
 * `HocuspocusSync` — Hocuspocus-backed write-path closure for
 * `SyncService.transact` (architecture.md §6.1 / ADR 0018 F31).
 *
 * Composition:
 *
 *   1. Dispatcher's `runInWriteTx` opens a SQL tx via
 *      `withSystemTx(setIsolationLevel("serializable") → BEGIN IMMEDIATE)`.
 *   2. Dispatcher calls `hocuspocusSync.bind({ sqlTx, principal,
 *      workspace_id })` to get a per-invocation `SyncService` whose
 *      `transact` closes over the tx handle.
 *   3. Capability handler calls `ctx.transact(doc_id, fn)` — routes to
 *      `server.openDirectConnection(doc_id).transact(callback)`.
 *   4. Inside the callback we subscribe to the Y.Doc's `update` event,
 *      run the handler's `fn`, unsubscribe. The captured update deltas
 *      are merged (`Y.mergeUpdates`) into a single blob.
 *   5. After `transact` returns, we hand the blob off to the injected
 *      `DocUpdatesWriter` which INSERTs `doc_updates` + `outbox(doc.updated)`
 *      through the SAME sql tx.
 *
 * Result: `docs` INSERT + `doc_updates` + `outbox(doc.updated)` +
 * `audit_events` (allow) commit together or not at all. Handler throw
 * rolls all four back. Invariant 7 closes end-to-end for **durable**
 * content mutations.
 *
 * **Known limitation — in-memory Y.Doc drift on abort (P3.6e follow-up).**
 * If a handler mutates the Y.Doc via `ctx.transact` and the outer SQL
 * tx later rolls back — via post-`ctx.transact` handler throw, output-
 * shape validation failure, or post-parse deny — the SQL rows roll back
 * cleanly but the live Hocuspocus `Document` retains the mutation in
 * memory. A subsequent read on the same sync instance before a server
 * restart can observe content with no matching `doc_updates` row. The
 * atomicity invariant (§7) is defined over durable state — the SQL
 * tuple — which holds end-to-end; durable truth is `doc_updates`, and
 * server restart rebuilds the Y.Doc from there. Pre-hydration (P3.6e
 * wires `onLoadDocument` replay from `doc_updates` + a
 * `SyncService.rollback(doc_id)` signal threaded from the dispatcher),
 * unloading the Y.Doc here would wipe any seed state this very
 * `ctx.transact` placed on it — an own-foot-shot that the Hocuspocus
 * test setup actively relies on (seed via `ctx.transact`, read back
 * across subsequent invocations). P3.6e closes the remaining gap.
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
 * **Test-shape composition.** `new Hocuspocus(...)` without `listen()`
 * works headless — the research pass and the `Hocuspocus.d.ts`
 * surface both confirm. No WebSocket, no HTTP server. We set
 * `debounce: 0` + `unloadImmediately: false` so `onStoreDocument`
 * doesn't fire on its own (we're not using it), and docs don't unload
 * between invocations.
 */

import type { AuditTx } from "@editorzero/audit";
import type { DocUpdatesWriter } from "@editorzero/db";
import type { DocId, WorkspaceId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";

import type { SyncService } from "./service";

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

export class HocuspocusSync {
  readonly #server: Hocuspocus;
  readonly #docUpdatesWriter: DocUpdatesWriter;
  readonly #liveConnections: Set<Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>> =
    new Set();
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
    });
  }

  /**
   * Return a `SyncService` whose `transact` routes through the shared
   * `Hocuspocus` instance and closes over `context` so
   * `DocUpdatesWriter.write(context.sqlTx, …)` commits inside the
   * dispatcher's open SQL transaction. One `HocuspocusSync` per
   * process; one `bind` per dispatcher invocation.
   *
   * The returned service's `close()` is a no-op — the underlying
   * Hocuspocus instance is process-scoped and closed via
   * `HocuspocusSync.close()`, not via a per-invocation handle. The
   * dispatcher must never call `close()` on a bound service.
   */
  bind(context: HocuspocusTxContext): SyncService {
    return {
      transact: <T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T> =>
        this.#runTransact(context, doc_id, fn),
      close: async () => {
        /* no-op — see class docstring */
      },
    };
  }

  /** Shut down Hocuspocus + release all resident Y.Docs. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Close every per-invocation direct connection we opened but
    // deferred disconnecting (see `#runTransact` for the rationale).
    // Disconnect also flushes `onStoreDocument` via
    // `storeDocumentHooks(immediately=true)` and, when the last
    // connection drops, unloads the Y.Doc — so we don't need a
    // separate `unloadDocument` loop.
    const connections = Array.from(this.#liveConnections);
    this.#liveConnections.clear();
    for (const direct of connections) {
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

    // Each per-invocation `direct.disconnect` triggers an
    // unconditional `unloadDocument` when the direct-connection count
    // drops to zero — the 3.4.4 disconnect path forces unload
    // regardless of `unloadImmediately` (source:
    // `DirectConnection.disconnect` at line 2142 of the built bundle).
    // If we disconnected after every transact, consecutive
    // `ctx.transact` calls on the same doc would each open a fresh
    // (empty) Y.Doc — the first write's state would be gone by the
    // second write. Holding the direct connections alive until
    // `HocuspocusSync.close()` keeps `getConnectionsCount() > 0` and
    // the Y.Doc resident. The live-connection set is cleaned up in
    // `close()`.
    //
    // Consequence: each invocation allocates one `DirectConnection`
    // object and increments `document.directConnectionsCount`. Memory
    // is O(invocations) until close, which is fine for a
    // process-scoped composition (the runtime wires one
    // `HocuspocusSync` per server lifetime).
    const direct = await this.#server.openDirectConnection(doc_id, context);
    this.#liveConnections.add(direct);
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
  }
}
