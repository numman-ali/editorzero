/**
 * BlockNote ⇄ Y.Doc conversion helpers (architecture.md §16.1 / ADR 0018).
 *
 * These are the minimal BlockNote bindings `@editorzero/sync` exports
 * today: two *pure* functions that write / read BlockNote blocks onto a
 * Y.XmlFragment inside a given Y.Doc. They construct an ephemeral
 * BlockNoteEditor purely for its ProseMirror/Yjs conversion machinery
 * (no `mount()`, no ProseMirror view), so they run in plain Node with
 * no DOM dependency.
 *
 * What they deliberately do NOT do:
 *   - Provide a live `editor.transact` surface for ongoing mutations.
 *     The BlockNote collaboration plugin requires a mounted ProseMirror
 *     view to flush edits back into the `Y.XmlFragment`; server-side
 *     that means either a `jsdom` + `editor.mount(document.createElement(
 *     "div"))` dance or `Hocuspocus.openDirectConnection`. ADR 0018's
 *     empirical-verification gate (Phase 3.6) picks the path; until
 *     then content *mutations* beyond the initial seed go through a
 *     follow-up helper, not this file.
 *   - Preserve history on `seedBlocks`. BlockNote's `blocksToYXmlFragment`
 *     is explicitly documented as "for importing existing content for
 *     the first time" — running it against a non-empty fragment would
 *     drop history (AGENTS.md gotcha). We enforce the first-time
 *     contract with a runtime assertion.
 *
 * `BLOCKNOTE_FRAGMENT` is the Y.XmlFragment name we bind to; reads
 * and writes must agree on it. `"document-store"` is a project
 * convention — BlockNote accepts any string.
 */

import {
  type Block,
  BlockNoteEditor,
  type BlockSchema,
  type InlineContentSchema,
  type PartialBlock,
  type StyleSchema,
} from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import type * as Y from "yjs";

export const BLOCKNOTE_FRAGMENT = "document-store";

/**
 * The base `BlockSchema` index signature (`Record<string, BlockConfig>`)
 * is not satisfied by BlockNote's concrete `DefaultBlockSchema` under
 * `exactOptionalPropertyTypes: true`. The blocks package works around
 * this with a `LooseBlock` alias (`Block<BlockSchema, InlineContentSchema,
 * StyleSchema>`) — same workaround here. The helpers accept / return
 * the loose shape; the `blocksToYXmlFragment` / `yXmlFragmentToBlocks`
 * calls internally take the default-typed editor via a cast that stays
 * local to this file.
 */
export type LooseBlock = Block<BlockSchema, InlineContentSchema, StyleSchema>;
export type LoosePartialBlock = PartialBlock<BlockSchema, InlineContentSchema, StyleSchema>;

type LooseEditor = BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>;

/**
 * Write `blocks` onto the Y.Doc's BlockNote fragment. Intended for
 * first-time seeding (e.g., `doc.create` writing the title + trailing
 * paragraph). Throws if the fragment already has content — running
 * this on an existing doc would drop history (BlockNote's own warning
 * on `blocksToYXmlFragment`). Use the live-editor path for updates.
 */
export function seedBlocks(ydoc: Y.Doc, blocks: LoosePartialBlock[]): void {
  const fragment = ydoc.getXmlFragment(BLOCKNOTE_FRAGMENT);
  if (fragment.length > 0) {
    throw new Error(
      "seedBlocks: refusing to seed a non-empty Y.XmlFragment — " +
        "blocksToYXmlFragment is documented as import-for-first-time only " +
        "and drops history. Use the live-editor path for updates.",
    );
  }
  const editor = ephemeralEditor();
  try {
    // `blocksToYXmlFragment`'s public type is `Block[]` (fully
    // materialised), but it's documented + implemented to accept
    // `PartialBlock[]` for first-time imports. The loose/partial cast
    // bridges both: BlockNote's runtime discriminates on block `type`,
    // so providing a partial of the right type is safe.
    blocksToYXmlFragment(editor, blocks as unknown as LooseBlock[], fragment);
  } finally {
    editor._tiptapEditor.destroy();
  }
}

/**
 * Read the BlockNote blocks stored in the Y.Doc's fragment. Pure
 * projection from the CRDT state — produces the same structure
 * `editor.document` would expose if a live editor were bound to the
 * same fragment.
 */
export function readBlocks(ydoc: Y.Doc): LooseBlock[] {
  const fragment = ydoc.getXmlFragment(BLOCKNOTE_FRAGMENT);
  const editor = ephemeralEditor();
  try {
    return yXmlFragmentToBlocks(editor, fragment);
  } finally {
    editor._tiptapEditor.destroy();
  }
}

/**
 * Construct a headless BlockNoteEditor for its schema + conversion
 * machinery. `BlockNoteEditor.create()` returns an editor typed over
 * the default schema; we widen to the loose `BlockSchema` base so the
 * conversion helpers accept it. Not suitable for mutation dispatch
 * (collab plugin needs a mounted view); fine for pure converters.
 */
function ephemeralEditor(): LooseEditor {
  return BlockNoteEditor.create() as unknown as LooseEditor;
}
