/**
 * `@editorzero/sync` — Yjs/Hocuspocus integration + `ctx.transact` impl.
 *
 * Architecture §16.1 pins this package as the sole importer of
 * `Y.Doc` / `Y.XmlFragment` (and, since ADR 0038, of `@tiptap/y-tiptap`);
 * handler code goes through `ctx.transact`, never raw Yjs (enforced by
 * `no-raw-ydoc-access` — coherence check today, future
 * `@editorzero/arch-lint` rule).
 *
 * Owned-layer primitives (`./blocks`, ADR 0038 — DOM-free, no live
 * editor, no happy-dom anywhere):
 *   - `readBlocks` — CRDT state → canonical block list.
 *   - `writeBlocks` — full post-state → fragment, one Yjs tx.
 *   - `seedBlocks` — first-time seed with pre-minted ids.
 *   - `setDocTitle` (`./set-title`) — the title-slot rule.
 * Content-mutation capabilities compose these inside `ctx.transact`
 * with the pure op applier from `@editorzero/blocks`.
 */

export { DOC_FRAGMENT, readBlocks, type SeedBlock, seedBlocks, writeBlocks } from "./blocks";
export type { CollabApplyUpdatePayload } from "./collab-gate";
export {
  type AppliedForeignUpdate,
  applyForeignUpdate,
  base64ToBytes,
  bytesToBase64,
  type ForeignUpdateRefusalReason,
  ForeignUpdateRefusedError,
} from "./foreign-update";
export {
  type CollabAuthorizePayload,
  HocuspocusSync,
  type HocuspocusSyncDeps,
  type HocuspocusTxContext,
} from "./hocuspocus";
export { MemorySyncService } from "./memory";
export type { BoundSyncService, SyncService } from "./service";
export { setDocTitle } from "./set-title";
