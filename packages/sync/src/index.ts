/**
 * `@editorzero/sync` — Yjs/Hocuspocus integration + `ctx.transact` impl.
 *
 * Architecture §16.1 pins this package as the sole importer of
 * `Y.Doc` / `Y.XmlFragment`; handler code goes through `ctx.transact`,
 * never raw Yjs (enforced by `no-raw-ydoc-access` — coherence check
 * today, future `@editorzero/arch-lint` rule).
 *
 * Three BlockNote-integration primitives:
 *   - `seedBlocks` / `readBlocks` (`./blocks`): pure converters for
 *     first-time seeds + read projections; no DOM needed.
 *   - `withLiveEditor` (`./live-editor`): mount a BlockNoteEditor bound
 *     to the fragment, hand to callback, tear down on exit. Needed by
 *     content-mutation capabilities (`doc.rename`, future `doc.update`)
 *     where y-prosemirror's `view.dispatch` path must fire. Requires a
 *     global DOM — api-server runtime registers happy-dom at boot;
 *     tests use `@vitest-environment happy-dom`.
 */

export {
  BLOCKNOTE_FRAGMENT,
  type LooseBlock,
  type LoosePartialBlock,
  readBlocks,
  seedBlocks,
} from "./blocks";
export { ensureDomGlobals } from "./dom-shim";
export { HocuspocusSync, type HocuspocusSyncDeps, type HocuspocusTxContext } from "./hocuspocus";
export { type LiveEditor, withLiveEditor } from "./live-editor";
export { MemorySyncService } from "./memory";
export type { BoundSyncService, SyncService } from "./service";
export { setDocTitle } from "./set-title";
