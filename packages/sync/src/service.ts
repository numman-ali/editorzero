/**
 * `SyncService` — the sync package's outward contract.
 *
 * The only sanctioned path to Y.Doc mutation (invariant 7 + ADR 0018).
 * Runtime composition (`@editorzero/runtime`) wires `SyncService.transact`
 * into the dispatcher's `ctx.transact`, usually by layering a
 * `bindEditor(ydoc, fn)` helper on top so handlers receive a
 * `BlockNoteEditor` rather than a raw `Y.Doc`.
 *
 * Two implementations are planned:
 *   1. `MemorySyncService` (this package, today) — in-process `Map<DocId,
 *      Y.Doc>` for unit tests and single-process dev runtimes.
 *   2. `HocuspocusSyncService` (later) — delegates to
 *      `server.openDirectConnection(doc_id).transact(fn)` so mutations
 *      share the live collaboration session and `doc_updates` persistence
 *      triggers as usual.
 *
 * Callbacks run inside `Y.Doc#transact` so sibling mutations batch into
 * a single update payload. The `T | Promise<T>` return on `fn` matches
 * the kernel's `CapabilityContext.transact` signature; async fns yield
 * control on their first `await` — mutations issued on the sync prefix
 * are batched, anything after an `await` is its own update. Same
 * constraint applies to the Hocuspocus-backed impl (Yjs transactions are
 * synchronous by design).
 */

import type { DocId } from "@editorzero/ids";
import type * as Y from "yjs";

export interface SyncService {
  /**
   * Run `fn` against the Y.Doc for `doc_id`, inside a Yjs transaction.
   * The Y.Doc is created on first access. Errors thrown by `fn`
   * propagate to the caller. Under the Hocuspocus-backed impl `fn`
   * receives a throwaway CLONE (ADR 0043): a throwing handler's
   * in-memory work is discarded with the clone, and the resident
   * Y.Doc — the state WebSocket clients sync against — never holds
   * anything a SQL transaction has not committed.
   */
  transact<T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T>;

  /** Release resources (destroy Y.Docs, clear internal state). */
  close(): Promise<void>;
}

/**
 * A write-path-bound `SyncService` (ADR 0018 §6.4 / F31; reshaped by
 * ADR 0043). Returned by backend-specific `bind()` methods —
 * `HocuspocusSync.bind(context)` is the primary producer. The handle
 * STAGES every update its `transact` persisted, keyed by `doc_id`,
 * for post-commit application to the resident Y.Doc.
 *
 * **Why two-branch finalize now (`commit()` + `rollback()`).** Under
 * the broadcast-after-commit substrate the commit path is no longer
 * a no-op: staged updates must apply to the resident Y.Doc AFTER the
 * SQL tx commits — that application is the moment attached WebSocket
 * clients receive the delta. A dispatcher that forgot `commit()`
 * would leave live clients stale until the doc rehydrates (liveness,
 * not correctness — the rows are durable); the integration suite
 * pins the broadcast arrival so the wiring can't silently drop.
 *
 * **Lifecycle.** One `BoundSyncService` per `runInWriteTx` invocation.
 * Handlers receive `bound.transact` via `ctx.transact`; the
 * dispatcher calls `bound.commit()` after `withSystemTx` resolves and
 * `bound.rollback()` in its catch path. The bound service is
 * discarded at the end of the invocation.
 */
export interface BoundSyncService extends SyncService {
  /**
   * Apply every staged update to its resident Y.Doc (the broadcast
   * moment) and advance the resident freshness watermark. Called by
   * `runInWriteTx` exactly once, after the SQL tx COMMITS. Never
   * throws — the mutation is already durable; apply failures are
   * logged loud and healed by the next cold hydration. Idempotent
   * on an empty binding.
   */
  commit(): Promise<void>;
  /**
   * Discard the staged updates. Called by `runInWriteTx` when its
   * closure threw — the SQL tx rolled back, the staged rows never
   * committed, and the resident Y.Doc was never touched (ADR 0043:
   * there is nothing to evict; the pre-0043 eviction/poisoning
   * machinery is gone). Idempotent; safe on a binding whose handler
   * never issued `ctx.transact`.
   */
  rollback(): Promise<void>;
}
