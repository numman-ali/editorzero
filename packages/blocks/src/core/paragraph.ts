/**
 * `editorzero:core/paragraph` — BlockTypeSpec (architecture.md §16.5, ADR 0013).
 *
 * Round-trip contract for the plainest block in the kernel: a
 * paragraph with styled inline text. CommonMark preserves `bold` +
 * `italic` + `code` styles on text; this spec declares tier
 * `lossless` for that subset (see `./inline.ts` for the exact
 * coverage).
 *
 * Non-default block props (`textColor`, `backgroundColor`,
 * `textAlignment`) are BlockNote UI concerns and do not survive a
 * CommonMark round-trip; a paragraph with such props set lies
 * outside this spec's lossless claim. The property harness (Phase 3)
 * fuzzes only paragraphs whose non-content props are at their
 * defaults, which keeps the tier claim honest.
 *
 * **Empty paragraphs are outside the block-level lossless claim.**
 * CommonMark has no spelling for an empty paragraph: any invented
 * sentinel (NBSP, ZWSP, mid-air Unicode characters) collides with
 * legitimate content that happens to contain the same code points.
 * `toMarkdown([])` emits the empty string and round-trips as "no
 * paragraph" at the block level. The *document-level* serializer
 * resolves empty-paragraph spacing by joining non-empty paragraphs
 * with blank lines; emitting an empty string at the block level is
 * what lets that document-level logic own the correct behaviour.
 * This carve-out mirrors the `textColor` / `backgroundColor` /
 * `textAlignment` carve-outs: real shapes that sit outside a
 * CommonMark-only tier.
 *
 * **Block-opener starter escape** is handled here: a paragraph whose
 * body begins with one of CommonMark's block-level openers (`>`,
 * `#`, `-`, `+`, ordered-list prefixes, thematic break) — optionally
 * after 0–3 leading spaces, which CommonMark still treats as a
 * block marker — would reparse as a different block type.
 * `escapeBlockOpener` prefixes the opener character with `\`, which
 * CommonMark consumes on parse; the resulting text node carries the
 * original content without the backslash, restoring the fixed point.
 */

import type { Block, BlockSchema, InlineContentSchema, StyleSchema } from "@blocknote/core";
import { z } from "zod";

import { type BlockTypeSpec, createBlockTypeSpec } from "../kernel";
import { inlineContentToMarkdown, mdastInlineToBlockNote } from "./inline";

export const PARAGRAPH_TYPE = "editorzero:core/paragraph" as const;

const paragraphAttributes = z.object({});

type LooseBlock = Block<BlockSchema, InlineContentSchema, StyleSchema>;

export const paragraph: BlockTypeSpec<Record<string, never>> = createBlockTypeSpec({
  type: PARAGRAPH_TYPE,
  tier: "lossless",
  attributes: paragraphAttributes,
  toMarkdown: (block) => {
    const body = inlineContentToMarkdown(block.content);
    if (body.length === 0) return "";
    return escapeBlockOpener(body);
  },
  fromMarkdown: (node) => {
    if (node.type !== "paragraph") return null;
    return {
      id: "",
      type: "paragraph",
      props: {},
      content: mdastInlineToBlockNote(node.children),
      children: [],
    } as unknown as LooseBlock;
  },
});

/**
 * Prefix a single backslash before the first non-indent character of
 * a paragraph body when that character would otherwise start a
 * different block on CommonMark re-parse.
 *
 * CommonMark accepts up to 3 leading spaces before a block marker
 * and still treats the marker as opening that block (4+ leading
 * spaces becomes indented code, which this function does NOT handle;
 * see the trailing comment). We carry the 0–3 space indent through
 * verbatim and escape the opener character *after* the indent so the
 * reparse produces a text node whose leading whitespace matches the
 * original content.
 *
 * The inline emitter already handles escape of `*`, `_`, `[`, `<`,
 * `` ` ``; the characters handled here are block-level openers that
 * slip through inline escape because they are harmless mid-text
 * (`>`, `-`, `+`, `#`) or whose block meaning depends on context
 * (digits before `.` / `)`).
 *
 * Backslash-escape consumes the first character as a literal on
 * parse; the resulting mdast text node carries the original content
 * (no backslash), so `mdastInlineToBlockNote` produces the original
 * BlockNote content array without any extra handling.
 *
 * Leading-whitespace cases with 4+ spaces (indented code) and tabs
 * are deliberately NOT handled: they require re-escaping that
 * collides with the emphasis-boundary-whitespace handling in
 * `./inline.ts`, and BlockNote does not normally produce paragraph
 * content with 4+ leading spaces at a run boundary.
 */
function escapeBlockOpener(md: string): string {
  // CommonMark tolerates 0–3 spaces of indent before a block marker.
  const indentMatch = /^( {0,3})/.exec(md);
  const indent = indentMatch?.[0] ?? "";
  const body = md.slice(indent.length);

  // Blockquote: `>` at the (indented) line start triggers regardless of
  // the following character.
  if (body.startsWith(">")) return `${indent}\\${body}`;
  // ATX heading: 1..6 `#`s followed by space or end-of-string.
  if (/^#{1,6}(\s|$)/.test(body)) return `${indent}\\${body}`;
  // Unordered list markers `-` / `+` followed by space. `*` is
  // already backslash-escaped by the inline emitter.
  if (/^[-+]\s/.test(body)) return `${indent}\\${body}`;
  // Ordered list: one or more digits + `.` or `)` + space.
  if (/^\d+[.)]\s/.test(body)) {
    return `${indent}${body.replace(/^(\d+)([.)])/, "$1\\$2")}`;
  }
  // Thematic break: a line consisting only of 3+ hyphens (and
  // optional trailing whitespace). `*` / `_` versions are already
  // handled by inline escape.
  if (/^-{3,}\s*$/.test(body)) return `${indent}\\${body}`;
  return md;
}
