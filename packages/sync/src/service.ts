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
