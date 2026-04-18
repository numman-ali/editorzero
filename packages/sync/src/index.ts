/**
 * `@editorzero/sync` — Yjs/Hocuspocus integration + `ctx.transact` impl.
 *
 * Architecture §16.1 pins this package as the sole importer of
 * `Y.Doc` / `Y.XmlFragment`; handler code goes through `ctx.transact`,
 * never raw Yjs (enforced by `no-raw-ydoc-access` — coherence check
 * today, future `@editorzero/arch-lint` rule).
 *
 * `seedBlocks` / `readBlocks` (see `./blocks`) are the BlockNote ↔
 * Y.Doc conversion helpers this slice ships — pure converters that
 * write / read BlockNote blocks on the shared Y.XmlFragment. A live-
 * editor mutation path (BlockNoteEditor bound to the fragment for
 * `doc.rename` / `doc.update`) is deferred to the ADR 0018 empirical-
 * verification gate (Phase 3.6): that path needs either `jsdom` +
 * `editor.mount()` or a Hocuspocus direct connection, and we don't
 * want to bake that choice in before the verification exercise.
 */

export {
  BLOCKNOTE_FRAGMENT,
  type LooseBlock,
  type LoosePartialBlock,
  readBlocks,
  seedBlocks,
} from "./blocks";
export { HocuspocusSync, type HocuspocusSyncDeps, type HocuspocusTxContext } from "./hocuspocus";
export { MemorySyncService } from "./memory";
export type { BoundSyncService, SyncService } from "./service";
