/**
 * `HocuspocusSync` — Hocuspocus-backed write-path closure for
 * `SyncService.transact` (architecture.md §6.1 / ADR 0018 F31), on the
 * **broadcast-after-commit substrate** (ADR 0043 Decision 1): the
 * resident Y.Doc holds committed state ONLY, and attached WebSocket
 * clients receive a delta exactly when the SQL transaction that
 * persisted it has committed.
 *
 * Composition:
 *
 *   1. Dispatcher's `runInWriteTx` opens a SQL tx via
 *      `withSystemTx(setIsolationLevel("serializable") → BEGIN IMMEDIATE)`.
 *   2. Dispatcher calls `hocuspocusSync.bind({ sqlTx, principal,
 *      workspace_id })` to get a per-invocation `BoundSyncService`
 *      whose `transact` closes over the tx handle and stages every
 *      persisted update for post-commit application.
 *   3. Capability handler calls `ctx.transact(doc_id, fn)`. Under the
 *      per-doc lock, the sync layer builds a **throwaway clone**:
 *      a snapshot of the resident Y.Doc (state = committed rows ≤ the
 *      `appliedSeq` watermark) topped up with the tx-view tail
 *      (`doc_updates` rows with `seq > watermark`, read through the
 *      OPEN tx handle — which is exactly committed rows the resident
 *      hasn't applied yet PLUS this binding's own staged rows:
 *      read-your-own-writes across multiple transacts in one
 *      dispatch). `fn` mutates the clone; the resident is never
 *      touched pre-commit.
 *   4. The captured clone updates merge (`Y.mergeUpdates`) into one
 *      blob; the injected `DocUpdatesWriter` INSERTs `doc_updates` +
 *      `outbox(doc.updated)` through the SAME sql tx and returns the
 *      allocated `seq`. The binding stages `{seq, blob}`.
 *   5. After the SQL tx COMMITS, the dispatcher calls
 *      `bound.commit()`: each staged blob applies to the resident
 *      Y.Doc under the per-doc lock — apply IS broadcast (Hocuspocus
 *      fans the resident's update event out to attached WS clients) —
 *      and the watermark advances. `commit()` never throws: the
 *      mutation is already durable, so an apply failure is a liveness
 *      problem (logged loud; healed by the next cold hydration), not
 *      a correctness one.
 *   6. If the tx rolls back, `bound.rollback()` just discards the
 *      staged blobs. The resident was never touched; the rows never
 *      committed; there is nothing to evict. The pre-ADR-0043
 *      eviction/poisoning machinery is deleted, not relocated.
 *
 * Result: `docs` INSERT + `doc_updates` + `outbox(doc.updated)` +
 * `audit_events` + `outbox(audit.appended)` commit together or not at
 * all (invariant 7), and in-memory state can no longer diverge from
 * durable state on ANY path — rollback discards a clone; clients
 * never see a delta that did not commit.
 *
 * **Resident freshness contract (ADR 0043).** resident =
 * committed-as-of-last-catch-up. The watermark is set at hydration
 * (`onLoadDocument` records the max applied `seq`) and advanced by
 * `commit()`. Reads (`HocuspocusSync.read`) snapshot the resident —
 * committed-only by construction. In a single process every commit
 * advances the resident it touched, so lag arises only from a failed
 * post-commit apply (logged; healed at next unload→rehydrate) or
 * writes from another process (multi-process is an ADR 0043 revisit
 * trigger, not a supported topology).
 *
 * **Why `commit()` applies the binding's OWN staged blobs rather than
 * re-reading committed rows.** better-sqlite3 has one connection: an
 * "untransacted" read issued while ANOTHER dispatch's tx is open runs
 * inside that tx's view and would pull ITS uncommitted rows onto the
 * resident — the exact divergence this substrate forbids. The staged
 * blobs are known-committed (withSystemTx returned before `commit()`
 * runs), so applying them needs no read at all. Cross-dispatch order
 * is safe without coordination: per-doc `seq` allocation serialises
 * on the `doc_counters` row (SQLite serialises whole txs; Postgres
 * blocks the counter UPDATE until the prior tx resolves), and Yjs
 * update application is commutative — out-of-order `commit()`
 * scheduling between two dispatches merges to the same state.
 *
 * **The watermark is CONTIGUOUS, not a max.** Committed seqs per doc
 * are gap-free (the counter UPDATE rolls back with its tx), but two
 * dispatches' `commit()`s can interleave out of seq order — seq 2 can
 * apply to the resident while committed seq 1 hasn't yet. A
 * max-watermark would jump to 2 and the next transact's tail read
 * (`seq > watermark`) would silently skip the committed-but-unapplied
 * row 1: a clone missing durable state, handed to a handler as truth.
 * So the watermark only advances across gap-free applied seqs;
 * ahead-of-gap applies park in `#aheadSeqs` until the gap fills. In
 * the window, tail reads re-fetch the already-applied-ahead rows —
 * re-applying a contained update to the clone is a Yjs no-op, so the
 * clone is complete AND convergent. This is also what guarantees the
 * transact clone starts with no pending structs — a precondition the
 * foreign-update lane's `not_integrable` refusal relies on
 * (`foreign-update.ts`): pending-after-apply is always the caller's
 * payload, never lane residue.
 *
 * **Why first-load write-path hydration reads the OPEN tx handle and
 * is still committed-only.** `onLoadDocument` fires once, at first
 * open. On the write path that open happens at the START of the first
 * `ctx.transact` for the doc — before this tx has persisted any row
 * for it — so the tx view equals committed state for THIS doc at that
 * moment. The per-doc singleton connection (open-replace, below)
 * keeps the doc resident for the rest of the dispatch, so hydration
 * cannot re-fire after the binding has staged rows. Sharing the tx
 * handle is load-bearing on SQLite (single connection — a separate
 * `driver.system()` read would block on `acquireConnection`).
 *
 * **WS-attach hydration mid-someone-else's-tx (SQLite).** The `__ws`
 * and `__read` branches hydrate through the untransacted handle,
 * which on better-sqlite3 is the same single connection — so a cold
 * hydration interleaved into an open write tx WOULD see its
 * uncommitted rows. By construction it cannot happen: any doc with
 * uncommitted `doc_updates` rows is resident (its writer's singleton
 * holds it open), and hydration only fires on non-resident docs.
 * Postgres reads committed-only trivially (separate connections).
 *
 * **Why capture updates via `Y.Doc#on("update", …)` on the clone.**
 * Same rationale as the pre-0043 shape: per `SyncService.transact`'s
 * contract `fn` may be async — anything after an `await` is its own
 * update event — so the listener brackets the full `fn` promise, not
 * just the synchronous prefix. The clone is destroyed in `finally`;
 * a throwing handler discards in-memory work by construction.
 *
 * **Why not persist inside Hocuspocus's `onStoreDocument` hook.** The
 * hook runs under `saveMutex` and is dedicated to the (future)
 * snapshot-compaction path. Update-side persistence happens here in
 * `transact`, directly against the injected writer + tx.
 *
 * **Test-shape composition.** `new Hocuspocus(...)` without `listen()`
 * works headless. Production WS clients enter through
 * `handleWsConnection`, fed by the `apps/server` upgrade handler
 * (`attachCollab`). We set `unloadImmediately: false` (and inherit
 * `debounce: 2000`) so `onStoreDocument` doesn't fire on its own and
 * docs stay resident between invocations.
 */

import type { AuditTx } from "@editorzero/audit";
import type { DocUpdatesReader, DocUpdatesWriter, SystemDb } from "@editorzero/db";
import type { DocId, WorkspaceId } from "@editorzero/ids";
import { type Logger, noopLogger } from "@editorzero/observability";
import type { Principal } from "@editorzero/principal";
import { Hocuspocus, type onAuthenticatePayload } from "@hocuspocus/server";
import * as Y from "yjs";

import { type CollabApplyUpdatePayload, createCollabWriteGate } from "./collab-gate";
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

/**
 * What the per-document WebSocket authorization policy sees — the
 * subset of Hocuspocus's `onAuthenticatePayload` that identity +
 * authority can be derived from. `requestHeaders` are the ORIGINAL
 * upgrade request's headers, which Hocuspocus re-presents on every
 * Auth frame: the policy re-resolves the principal from them each
 * time (cookie → session → roles), so a session revoked after the
 * socket was established is denied on the next document attach —
 * nothing identity-shaped is trusted from connection context (the
 * stale-snapshot trap the ADR 0030 hardening review flagged).
 */
export type CollabAuthorizePayload = Pick<onAuthenticatePayload, "documentName" | "requestHeaders">;

export interface HocuspocusSyncDeps {
  readonly docUpdatesWriter: DocUpdatesWriter;
  /**
   * Dispatches between two shapes from its call sites —
   * `readByDoc(auditTx, doc_id, afterSeq?)` on the write path (shares
   * the enclosing SQL tx: first-load hydration + the clone's tail
   * top-up), and `readByDocUntransacted(systemDb, doc_id)` on the
   * read/WS paths (untransacted, no RESERVED lock). Rows carry `seq`
   * for the watermark (see class docstring).
   */
  readonly docUpdatesReader: DocUpdatesReader;
  /**
   * Untransacted `Kysely<SystemDatabase>` handle, supplied by the
   * composition root via `driver.system()`. Consumed by the
   * `onLoadDocument` hook on the read/WS paths: hydration reads
   * committed `doc_updates` via
   * `docUpdatesReader.readByDocUntransacted(systemDb, doc_id)`. WAL
   * on SQLite + the Postgres pool both let this run concurrently
   * with live writers.
   */
  readonly systemDb: SystemDb;
  /**
   * Per-document WebSocket authorization policy (ADR 0030 blockers
   * 1/3/4). Fires once per (socket, documentName) Auth frame — the
   * client must authenticate each document it attaches to on a
   * multiplexed socket. Throw to deny: Hocuspocus answers
   * `permission-denied` for that document only; other documents on
   * the socket are unaffected. After the policy passes, the class
   * sets `connectionConfig.readOnly` from `collabReadOnly`, so no
   * attach policy can widen write posture beyond what the operator
   * configured.
   *
   * OPTIONAL with a deny-all default, which is by-construction
   * fail-closed: Hocuspocus treats a *hook-less* server as requiring
   * no authentication (full read/write for any socket — the original
   * red-team finding). This class therefore ALWAYS registers
   * `onAuthenticate`; a `HocuspocusSync` built without an explicit
   * policy refuses every WS attach rather than admitting them. The
   * dispatcher's `DirectConnection` lane never fires `onAuthenticate`
   * (verified in the 3.4.4 source — `openDirectConnection` constructs
   * its connection config directly), so registering the hook cannot
   * affect HTTP-path writes.
   */
  readonly collabAuthorize?: (payload: CollabAuthorizePayload) => Promise<void>;
  /**
   * WS write policy for the `beforeHandleMessage` gate (ADR 0043
   * Decision 3): called once per NOVEL update-bearing frame on a
   * non-readOnly connection, with the extracted Yjs payload as base64.
   * The composition root's policy re-resolves the principal from the
   * upgrade headers and dispatches `doc.apply_update`; a throw refuses
   * the frame and Hocuspocus closes that per-document connection.
   * OPTIONAL with a reject-all default (fail-closed, like
   * `collabAuthorize`) — see `createCollabWriteGate`. The gate itself
   * is ALWAYS registered: its protocol rails (`BroadcastStateless`
   * refused, unknown frame types closed, total classification of
   * update-bearing subtypes) hold regardless of write posture.
   */
  readonly collabApplyUpdate?: (payload: CollabApplyUpdatePayload) => Promise<void>;
  /**
   * The `connectionConfig.readOnly` value every authorized WS attach
   * gets. DEFAULT FALSE — the ADR 0043 Decision 3 write lane is the
   * production posture: every update-bearing frame flows through the
   * `beforeHandleMessage` gate into the audited `doc.apply_update`
   * dispatch. The lift was gated on Decision 5 (socket registry +
   * event-driven revocation closes) and landed WITH it — per-frame
   * re-resolution protects the next write, the registry closes the
   * passive read feed. TRUE is the operator escape hatch (emergency
   * read-only pin) and the unit posture for exercising the native
   * nacked-not-applied contract on readOnly connections.
   */
  readonly collabReadOnly?: boolean;
  /**
   * Post-commit apply failures are liveness, not correctness — the
   * mutation is durable; only the live broadcast lagged. They log
   * loud here (no silent failures) instead of throwing into a
   * dispatch whose SQL already committed. Defaults to a no-op logger
   * for unit shapes; the composition root passes the real one.
   */
  readonly logger?: Logger;
  /**
   * Optional hocuspocus tuning. Defaults are test-safe: the inherited
   * `debounce` + `unloadImmediately: false` keep `onStoreDocument`
   * from firing and docs resident across invocations. Production
   * wiring will override with real values + a compaction hook.
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

/**
 * Connection context for WebSocket clients — `handleWsConnection`
 * passes this (and nothing else) as Hocuspocus's `defaultContext`.
 * The `onLoadDocument` hook hydrates `__ws` opens from committed
 * `doc_updates` via the untransacted reader, exactly like `__read`
 * opens. Deliberately carries NO principal: identity is re-resolved
 * per Auth frame inside `collabAuthorize`, never snapshotted onto
 * the connection.
 */
interface HocuspocusWsMarker {
  readonly __ws: true;
}

interface StagedUpdate {
  readonly seq: number;
  readonly blob: Uint8Array;
}

type DirectConnection = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;
type WsConnectionArgs = Parameters<Hocuspocus["handleConnection"]>;

export class HocuspocusSync {
  readonly #server: Hocuspocus;
  readonly #docUpdatesWriter: DocUpdatesWriter;
  readonly #docUpdatesReader: DocUpdatesReader;
  readonly #logger: Logger;
  /**
   * Singleton `DirectConnection` per `doc_id`. Each open (transact or
   * read) opens a fresh connection (carrying the current invocation's
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
   * invocation count (Codex P3.6e adversarial review).
   *
   * Residency is also a CORRECTNESS term post-ADR-0043: "any doc with
   * uncommitted `doc_updates` rows is resident" is what makes cold
   * WS/read hydration committed-only on SQLite's single connection
   * (class docstring).
   */
  readonly #liveConnections: Map<DocId, DirectConnection> = new Map();
  /**
   * Per-doc async mutex (closes Codex P3.6c adversarial P1).
   *
   * Serialises the whole `open → clone → mutate → persist` sequence
   * per doc, orders reads against writes, and serialises `commit()`'s
   * staged-blob application against both. The chain stores
   * "error-swallowing" tails so a throwing handler doesn't poison
   * subsequent waiters.
   *
   * SQLite's single-connection serialisation already funnels
   * `withSystemTx` calls end-to-end, so the mutex is belt-and-
   * suspenders there; for Postgres (ADR 0007), where `withSystemTx`
   * runs on independent connections, the mutex is load-bearing.
   */
  readonly #docLocks: Map<DocId, Promise<void>> = new Map();
  /**
   * The resident-freshness watermark: the highest `doc_updates.seq` S
   * such that EVERY committed seq ≤ S has been applied to the resident
   * Y.Doc (contiguous — see the class docstring for why a max would
   * hand transact clones stale state). Set at hydration (committed
   * rows are gap-free, so last-row seq is contiguous by construction),
   * advanced by `commit()` via `#advanceWatermark`, dropped on
   * document unload. A doc absent from the map and absent from
   * `#server.documents` simply re-hydrates; a resident doc is always
   * watermarked (hydration runs before any open path hands out a
   * reference).
   */
  readonly #appliedSeq: Map<DocId, number> = new Map();
  /**
   * Seqs applied to the resident ABOVE the contiguous watermark — the
   * out-of-order `commit()` window. Drained into `#appliedSeq` by
   * `#advanceWatermark` as gaps fill; cleared with the watermark on
   * unload/rehydration. Bounded by in-flight dispatch concurrency.
   */
  readonly #aheadSeqs: Map<DocId, Set<number>> = new Map();
  #closed = false;

  constructor(deps: HocuspocusSyncDeps) {
    this.#docUpdatesWriter = deps.docUpdatesWriter;
    this.#docUpdatesReader = deps.docUpdatesReader;
    this.#logger = deps.logger ?? noopLogger;
    // Deny-all unless the composition root supplies a policy — see
    // the `collabAuthorize` deps docstring for why optional-with-
    // deny-default is the by-construction posture here.
    const collabAuthorize =
      deps.collabAuthorize ??
      (() => Promise.reject(new Error("collab: no authorization policy configured")));
    const reader = deps.docUpdatesReader;
    const systemDb = deps.systemDb;
    const appliedSeq = this.#appliedSeq;
    const aheadSeqs = this.#aheadSeqs;
    const collabReadOnly = deps.collabReadOnly ?? false;
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
      // Per-document WS authorization (ADR 0030). Registered HERE so
      // the gate exists by construction — a Hocuspocus with no
      // `onAuthenticate` treats sockets as requiring no auth at all.
      // Fires per (socket, documentName) Auth frame; never fires for
      // the dispatcher's DirectConnections (3.4.4 source:
      // `openDirectConnection` builds its connectionConfig directly).
      onAuthenticate: async ({ documentName, requestHeaders, connectionConfig }) => {
        await collabAuthorize({ documentName, requestHeaders });
        // Default posture is lifted (ADR 0043 Decisions 3+5 landed):
        // the gate below makes every non-readOnly connection's writes
        // audited (each novel frame = one `doc.apply_update`
        // dispatch). A TRUE pin keeps the native nacked-not-applied
        // contract — see the `collabReadOnly` deps docstring.
        connectionConfig.readOnly = collabReadOnly;
      },
      // The audited-WS-write-lane gate (ADR 0043 Decision 3). ALWAYS
      // registered — its protocol rails (BroadcastStateless refused,
      // unknown types closed) hold regardless of write posture, and
      // its default write policy rejects (fail-closed). Never fires
      // for DirectConnections (no `Connection` object), so the
      // dispatcher's own writes can't re-enter the gate.
      beforeHandleMessage: createCollabWriteGate({
        ...(deps.collabApplyUpdate !== undefined && {
          collabApplyUpdate: deps.collabApplyUpdate,
        }),
        logger: this.#logger,
      }),
      // Hydration: the Document passed in is the server's canonical
      // Y.Doc instance for this documentName. Applying updates
      // directly to it is what Hocuspocus itself would do if we
      // returned a throwaway Y.Doc from the hook (verified at
      // `Hocuspocus.esm.js:2458-2466`); writing to the canonical
      // instance skips the extra encode/decode. Every applied row
      // advances the watermark — hydration is the watermark's birth.
      //
      // **Three-way dispatch on `context`.**
      //
      //   1. Write-path bind — `context.sqlTx` set. Read through the
      //      tx handle; committed-only by the first-load argument in
      //      the class docstring.
      //   2. Read-path / WebSocket attach — `__read` / `__ws` marker.
      //      Untransacted hydration from committed rows; safe by the
      //      residency argument in the class docstring.
      //   3. Bare opens (test fixtures simulating a concurrent
      //      connection holder). Skip hydration — the sanctioned
      //      openers above are the only paths that need it. (No
      //      watermark either: bare docs aren't part of the
      //      freshness contract.)
      //
      // Throwing out of the hook causes Hocuspocus to
      // `unloadDocument` + `closeConnections` + rethrow — the
      // `openDirectConnection` promise will reject, surfacing the
      // replay failure to the caller rather than loading a
      // partially-hydrated Y.Doc.
      onLoadDocument: async ({ document, documentName, context }) => {
        const maybeCtx = context as
          | (Partial<HocuspocusTxContext> &
              Partial<HocuspocusReadMarker> &
              Partial<HocuspocusWsMarker>)
          | null
          | undefined;
        const doc_id = documentName as DocId;
        const sqlTx = maybeCtx?.sqlTx;
        if (sqlTx !== undefined) {
          const rows = await reader.readByDoc(sqlTx, doc_id);
          for (const row of rows) {
            Y.applyUpdate(document, row.update_blob);
          }
          const last = rows[rows.length - 1];
          // Committed rows are gap-free, so the last seq is contiguous
          // by construction — fresh watermark, no ahead set.
          appliedSeq.set(doc_id, last === undefined ? 0 : last.seq);
          aheadSeqs.delete(doc_id);
          return;
        }
        if (maybeCtx?.__read === true || maybeCtx?.__ws === true) {
          const rows = await reader.readByDocUntransacted(systemDb, doc_id);
          for (const row of rows) {
            Y.applyUpdate(document, row.update_blob);
          }
          const last = rows[rows.length - 1];
          appliedSeq.set(doc_id, last === undefined ? 0 : last.seq);
          aheadSeqs.delete(doc_id);
          return;
        }
      },
      // The watermark dies with the resident: a re-hydration sets a
      // fresh one, and a stale entry for an unloaded doc would make
      // the next hydration's `set` look like a regression in tests
      // that assert map size. Fires for both unload paths (debounced
      // and immediate) in 3.4.4.
      afterUnloadDocument: async ({ documentName }) => {
        appliedSeq.delete(documentName as DocId);
        aheadSeqs.delete(documentName as DocId);
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
   * The binding STAGES every `{seq, blob}` its `transact` persisted.
   * The dispatcher's `runInWriteTx` calls `bound.commit()` after the
   * SQL tx commits (staged blobs apply to the resident — the
   * broadcast moment) and `bound.rollback()` in its catch path
   * (staged blobs discard; the resident was never touched).
   *
   * The returned service's `close()` is a no-op — the underlying
   * Hocuspocus instance is process-scoped and closed via
   * `HocuspocusSync.close()`, not via a per-invocation handle. The
   * dispatcher must never call `close()` on a bound service.
   */
  bind(context: HocuspocusTxContext): BoundSyncService {
    const staged: Map<DocId, StagedUpdate[]> = new Map();
    return {
      transact: <T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T> => {
        let bucket = staged.get(doc_id);
        if (bucket === undefined) {
          bucket = [];
          staged.set(doc_id, bucket);
        }
        return this.#runTransact(context, doc_id, bucket, fn);
      },
      commit: async () => {
        for (const [doc_id, updates] of staged) {
          if (updates.length === 0) continue;
          await this.#applyCommitted(doc_id, updates);
        }
        staged.clear();
      },
      rollback: async () => {
        // The SQL tx rolled back: the staged rows never committed and
        // the resident was never touched. Dropping the staging map IS
        // the rollback — nothing in memory diverges (ADR 0043).
        staged.clear();
      },
      close: async () => {
        /* no-op — see class docstring */
      },
    };
  }

  /**
   * Tx-less read-path Y.Doc opener (§6.4 — "reads must not take the
   * RESERVED lock `BEGIN IMMEDIATE` grabs"). Runs `fn` against a
   * **throwaway clone** of the resident Y.Doc for `doc_id`, without
   * opening a SQL write tx.
   *
   * Committed-only by construction (ADR 0043): the resident never
   * holds pre-commit state, so neither does the clone — the pre-0043
   * "visibility gap on commit-in-flight writes" is gone, not
   * narrowed. Freshness is the resident contract: committed-as-of-
   * last-catch-up.
   *
   * Serialises against concurrent `bind().transact` on the same doc
   * via `#withDocLock` — a read never interleaves into a write's
   * clone/persist/apply sequence.
   *
   * **Clone-before-fn (Codex Slice-1 finding — contamination guard).**
   * `fn` gets a materialised throwaway built from
   * `Y.encodeStateAsUpdate(resident)`; handler mutations touch only
   * the clone (destroyed in `finally`), so a misbehaving read can't
   * dirty resident state.
   *
   * **No principal / workspace_id.** Reads don't attribute
   * `doc_updates` rows or mint audit entries; the read API stays
   * narrower than the write-bind context so callers can't
   * accidentally thread mismatched identity through a read path.
   *
   * **Cost.** `Y.encodeStateAsUpdate` + `Y.applyUpdate` on a clone
   * per read call is O(doc state). Undo/redo history is not
   * preserved on the clone — acceptable because the read path has no
   * undo/redo semantics anyway. Callers must read plain data out of
   * the clone inside `fn`; Y types returned after `clone.destroy()`
   * have undefined behaviour.
   */
  async read<T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T> {
    return this.#withDocLock(doc_id, () => this.#runRead(doc_id, fn));
  }

  /**
   * Hand an upgraded WebSocket to the embedded Hocuspocus — the ONE
   * production WS entry point (ADR 0030). Routing clients into the
   * same instance the dispatcher writes through is what makes live
   * convergence real: a committed `ctx.transact` applies its delta
   * to the resident Y.Doc and Hocuspocus broadcasts it to attached
   * clients (post-commit only, ADR 0043).
   *
   * The caller (`attachCollab` in apps/server) has already enforced
   * the upgrade-time boundary: path, Origin allow-list, and an
   * authenticated session cookie. Per-document authorization happens
   * here-after, per Auth frame, via the constructor-registered
   * `onAuthenticate` → `collabAuthorize` — which re-resolves the
   * principal from the request headers each time, so nothing
   * identity-shaped rides the connection context. The context carries
   * only the `__ws` hydration marker.
   */
  handleWsConnection(websocket: WsConnectionArgs[0], request: WsConnectionArgs[1]): void {
    if (this.#closed) {
      websocket.close();
      return;
    }
    const wsMarker: HocuspocusWsMarker = { __ws: true };
    this.#server.handleConnection(websocket, request, wsMarker);
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
      const snapshot = await this.#snapshotResident(direct);
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
   * pattern (bounded at 1) and to attach observer WS clients for the
   * broadcast-after-commit property pins. Not for production
   * composition — the runtime wires `HocuspocusSync` by its public
   * `bind` / `read` / `close` surface.
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
   * Chain-based per-doc mutex. Transacts, reads, and commit-applies
   * route through here so concurrent same-doc work queues. See
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
    staged: StagedUpdate[],
    fn: (ydoc: Y.Doc) => T | Promise<T>,
  ): Promise<T> {
    return this.#withDocLock(doc_id, () => this.#runTransactLocked(context, doc_id, staged, fn));
  }

  /**
   * Snapshot the resident Y.Doc through its DirectConnection.
   * `direct.transact` is the only documented way to get a Y.Doc
   * reference off a `DirectConnection` (3.4.4 source — the callback
   * receives the canonical `Document` instance). Read-only: no
   * listener, no mutation.
   */
  async #snapshotResident(direct: DirectConnection): Promise<Uint8Array> {
    let snapshot: Uint8Array | undefined;
    await direct.transact((liveDoc) => {
      snapshot = Y.encodeStateAsUpdate(liveDoc as unknown as Y.Doc);
    });
    if (snapshot === undefined) {
      throw new Error("HocuspocusSync: direct.transact did not yield a Y.Doc");
    }
    return snapshot;
  }

  async #runTransactLocked<T>(
    context: HocuspocusTxContext,
    doc_id: DocId,
    staged: StagedUpdate[],
    fn: (ydoc: Y.Doc) => T | Promise<T>,
  ): Promise<T> {
    if (this.#closed) {
      throw new Error("HocuspocusSync: transact called after close()");
    }

    // **Open-replace pattern for per-doc singleton retention.** Each
    // invocation opens a fresh `DirectConnection` carrying *this
    // invocation's* context, replaces the map entry, and disconnects
    // the previous singleton in `finally`. The overlap keeps the
    // direct-connection count ≥ 1 across the swap so the Y.Doc stays
    // resident — a §6.4 throughput term, and post-ADR-0043 also the
    // committed-only-hydration residency term (class docstring).
    // First open fires `onLoadDocument` (hydration + watermark).
    const direct = await this.#server.openDirectConnection(doc_id, context);
    const previous = this.#liveConnections.get(doc_id);
    this.#liveConnections.set(doc_id, direct);

    const updates: Uint8Array[] = [];
    const captureUpdate = (update: Uint8Array, _origin: unknown): void => {
      updates.push(update);
    };

    try {
      // **The clone (ADR 0043).** resident snapshot (state ≤ watermark)
      // + the tx-view tail (committed rows the resident hasn't caught
      // up to, plus THIS binding's own staged rows — read-your-own-
      // writes). `fn` mutates the clone; the resident stays committed-
      // only until `bound.commit()`.
      const snapshot = await this.#snapshotResident(direct);
      const clone = new Y.Doc();
      try {
        Y.applyUpdate(clone, snapshot);
        const watermark = this.#appliedSeq.get(doc_id) ?? 0;
        const tail = await this.#docUpdatesReader.readByDoc(context.sqlTx, doc_id, watermark);
        for (const row of tail) {
          Y.applyUpdate(clone, row.update_blob);
        }

        // **Listener lifetime.** Per `SyncService.transact`'s contract,
        // `fn` may be async — "anything after an await is its own
        // update." Post-await mutations fire update events after the
        // synchronous prefix returns, so the listener brackets the
        // full `fn` promise resolution, not a sync section.
        clone.on("update", captureUpdate);
        let finalResult: T;
        try {
          finalResult = await fn(clone);
        } finally {
          clone.off("update", captureUpdate);
        }

        // Non-empty update set → persist + stage. An empty set means
        // the handler called `ctx.transact` but issued no Y.Doc
        // mutations — a no-op path that should not produce a
        // `doc_updates` row (seq would advance for nothing) and has
        // nothing to apply at commit.
        if (updates.length > 0) {
          const merged = Y.mergeUpdates(updates);
          const written = await this.#docUpdatesWriter.write(context.sqlTx, {
            doc_id,
            workspace_id: context.workspace_id,
            update_blob: merged,
            principal: context.principal,
          });
          staged.push({ seq: written.seq, blob: merged });
        }

        return finalResult;
      } finally {
        clone.destroy();
      }
    } finally {
      // Disconnect the previous singleton AFTER the new one is stored
      // in the map (so the Y.Doc's connection count overlaps and it
      // stays resident through the swap). Runs on both the commit and
      // the throw paths — in either case, the new `direct` is the
      // holder, and `previous` is safe to release.
      if (previous !== undefined && previous !== direct) {
        await previous.disconnect();
      }
    }
  }

  /**
   * Post-commit application of one doc's staged blobs to the resident
   * Y.Doc — the broadcast moment (ADR 0043 Decision 1). Runs under
   * the per-doc lock so it serialises against in-flight transacts and
   * reads. Never throws: the rows are durable; a failed apply is
   * logged loud and healed by the next cold hydration (the resident
   * unloads eventually; `onLoadDocument` replays committed rows).
   *
   * If the doc is not resident there is nothing to apply or
   * broadcast — the next hydration reads the committed rows,
   * staged blobs included. Two dispatches' `commit()`s may interleave
   * out of seq order (Yjs application is commutative — same merged
   * state either way); the watermark advances contiguously via
   * `#advanceWatermark` so tail reads never skip a committed row that
   * hasn't reached the resident (class docstring).
   */
  async #applyCommitted(doc_id: DocId, updates: readonly StagedUpdate[]): Promise<void> {
    try {
      await this.#withDocLock(doc_id, async () => {
        const document = this.#server.documents.get(doc_id);
        if (document === undefined) {
          this.#appliedSeq.delete(doc_id);
          this.#aheadSeqs.delete(doc_id);
          return;
        }
        for (const update of updates) {
          Y.applyUpdate(document, update.blob);
          this.#advanceWatermark(doc_id, update.seq);
        }
      });
    } catch (error) {
      this.#logger.error("sync commit-apply failed — broadcast lags until rehydration", {
        "doc.id": doc_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Record `seq` as applied to the resident and advance the contiguous
   * watermark as far as the gap-free prefix allows. An apply that lands
   * ahead of a gap parks in `#aheadSeqs`; the apply that fills the gap
   * drains every parked successor in one pass.
   */
  #advanceWatermark(doc_id: DocId, seq: number): void {
    const current = this.#appliedSeq.get(doc_id) ?? 0;
    if (seq <= current) {
      return;
    }
    if (seq > current + 1) {
      let ahead = this.#aheadSeqs.get(doc_id);
      if (ahead === undefined) {
        ahead = new Set();
        this.#aheadSeqs.set(doc_id, ahead);
      }
      ahead.add(seq);
      return;
    }
    let next = seq;
    const ahead = this.#aheadSeqs.get(doc_id);
    if (ahead !== undefined) {
      while (ahead.delete(next + 1)) {
        next += 1;
      }
      if (ahead.size === 0) {
        this.#aheadSeqs.delete(doc_id);
      }
    }
    this.#appliedSeq.set(doc_id, next);
  }
}
