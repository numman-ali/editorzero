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
   * The Y.Doc is created on first access. Errors thrown by `fn` propagate
   * to the caller; the Y.Doc's in-memory state after an error is
   * intentionally not rolled back — durable persistence (via
   * `doc_updates`) only lands after successful handler completion, so
   * any mid-mutation error is ephemeral.
   */
  transact<T>(doc_id: DocId, fn: (ydoc: Y.Doc) => T | Promise<T>): Promise<T>;

  /** Release resources (destroy Y.Docs, clear internal state). */
  close(): Promise<void>;
}

/**
 * A write-path-bound `SyncService` (ADR 0018 §6.4 / F31). Returned by
 * backend-specific `bind()` methods — `HocuspocusSync.bind(context)`
 * is the primary producer. The handle tracks which `doc_id`s the
 * handler mutated via `transact` so the dispatcher's `runInWriteTx`
 * can drop their in-memory Y.Doc state when the enclosing SQL tx
 * rolls back.
 *
 * **Why `rollback()` and not `finalize("commit"|"rollback")`.** The
 * commit path is a no-op — the in-memory Y.Doc is the source of
 * truth post-commit until the next server restart re-hydrates it
 * from `doc_updates`. A two-branch finalize would add a required
 * call on the happy path for symmetry only; the dispatcher forgetting
 * to fire it would silently leak nothing. `rollback()` keeps the
 * failure-only coupling explicit.
 *
 * **Lifecycle.** One `BoundSyncService` per `runInWriteTx` invocation.
 * Handlers receive `bound.transact` via `ctx.transact`; the
 * dispatcher calls `bound.rollback()` in its catch path. The bound
 * service is discarded at the end of the invocation.
 */
export interface BoundSyncService extends SyncService {
  /**
   * Drop the in-memory Y.Doc state for every `doc_id` mutated via
   * this binding's `transact`. Called by `runInWriteTx` when its
   * closure threw — the SQL tx rolls back, and so the Y.Doc in
   * memory must re-hydrate from `doc_updates` next time it is
   * opened. Idempotent; safe to call on a binding whose handler
   * never issued `ctx.transact`.
   *
   * **Scope.** The Hocuspocus-backed impl can only evict the Document
   * when no WebSocket client connections are attached — Hocuspocus's
   * `shouldUnloadDocument` gates on total `getConnectionsCount() === 0`.
   * For docs with live editor sessions, the aborted delta stays in
   * memory and in client-local Y.Docs; full atomicity there requires
   * buffering broadcasts until SQL commit (Phase 4 scope).
   */
  rollback(): Promise<void>;
}
