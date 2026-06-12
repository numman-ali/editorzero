/**
 * `@editorzero/blocks` — the owned block layer (ADR 0038, architecture.md §16.5).
 *
 * One package, one block type system, four projections of it:
 *   - the canonical block JSON model (`./model`) — the wire shape;
 *   - the Markdown round-trip specs (`./kernel` + `./core/*`, ADR 0013);
 *   - the Tiptap v3 editor schema (`./tiptap`) — browser editor and
 *     server-compiled ProseMirror schema alike;
 *   - the ProseMirror JSON mapping (`./pm`) + the `doc.update` op
 *     semantics (`./ops`, with the isomorphic content hash in
 *     `./hash`) that both the server applier and the Web UI diff use.
 *
 * No Yjs here — `@editorzero/sync` stays the sole Y.Doc importer
 * (architecture §16.1); this package is pure data + schema.
 */

export { HEADING_TYPE, type HeadingAttributes, heading, headingAttributes } from "./core/heading";
export { inlineContentToMarkdown, isStyledText, mdastInlineToStyledText } from "./core/inline";
export { PARAGRAPH_TYPE, paragraph, paragraphAttributes } from "./core/paragraph";
export { canonicalize, hashBlockContent, stableHash } from "./hash";
export type { AnyBlockTypeSpec, BlockTypeSpec, MdastBlockNode } from "./kernel";
export { createBlockTypeSpec } from "./kernel";
export {
  type Block,
  materializeBlock,
  normalizeContent,
  type PartialBlockInput,
  type StyledText,
  TEXT_STYLE_KEYS,
  type TextStyleKey,
  type TextStyles,
} from "./model";
export { type ApplyOpsResult, applyOpsToBlocks, diffBlocksToOps } from "./ops";
export { blocksToPmDoc, type PmDocJSON, pmDocToBlocks } from "./pm";
export { editorExtensions, getEditorSchema, HEADING_LEVELS } from "./tiptap";
