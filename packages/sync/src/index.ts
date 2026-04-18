/**
 * `@editorzero/sync` — Yjs/Hocuspocus integration + `ctx.transact` impl.
 *
 * Architecture §16.1 pins this package as the sole importer of
 * `Y.Doc` / `Y.XmlFragment`; handler code goes through `ctx.transact`,
 * never raw Yjs (enforced by `no-raw-ydoc-access` — coherence check
 * today, future `@editorzero/arch-lint` rule). The `bind-editor.ts`
 * helper (which wraps a Y.XmlFragment into a `BlockNoteEditor` for
 * server-side mutation) lands alongside the first capability that
 * needs it — `doc.create` — in the next commit of the P3.5 slice.
 */

export { MemorySyncService } from "./memory";
export type { SyncService } from "./service";
