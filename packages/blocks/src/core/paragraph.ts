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
 * Two paragraph-level round-trip hazards are handled here (and are
 * the reason the tier claim is real, not aspirational):
 *   1. *Empty paragraph.* CommonMark has no direct spelling for an
 *      empty paragraph — a blank line is a block separator, and
 *      emitting "" produces a document where
 *      `fromMarkdown(toMarkdown(x))` drops the empty paragraph.
 *      `EMPTY_PARAGRAPH_SENTINEL` (U+00A0) passes through CommonMark
 *      as a literal text node; `fromMarkdown` recognizes it and
 *      restores the empty content array.
 *   2. *Block-opener starter.* A paragraph whose first character is
 *      one of CommonMark's block-level openers (`>`, `#`, `-`, `+`,
 *      ordered-list prefixes, thematic-break) would reparse as a
 *      different block type. `escapeBlockOpener` prefixes the
 *      character with `\`, which CommonMark consumes on parse — the
 *      resulting text node carries the original content without the
 *      backslash, restoring the fixed point.
 */

import type { Block, BlockSchema, InlineContentSchema, StyleSchema } from "@blocknote/core";
import { z } from "zod";

import { type BlockTypeSpec, createBlockTypeSpec } from "../kernel";
import { inlineContentToMarkdown, mdastInlineToBlockNote } from "./inline";

export const PARAGRAPH_TYPE = "editorzero:core/paragraph" as const;

/**
 * Non-breaking space (U+00A0). CommonMark preserves it as a literal
 * character (it is not whitespace for parser purposes — a paragraph
 * containing only `\u00a0` is a paragraph, not a blank line). We
 * emit exactly one NBSP for an empty paragraph and recognize the
 * same single-character shape on import to restore `content: []`.
 */
const EMPTY_PARAGRAPH_SENTINEL = "\u00a0";

const paragraphAttributes = z.object({});

type LooseBlock = Block<BlockSchema, InlineContentSchema, StyleSchema>;

export const paragraph: BlockTypeSpec<Record<string, never>> = createBlockTypeSpec({
  type: PARAGRAPH_TYPE,
  tier: "lossless",
  attributes: paragraphAttributes,
  toMarkdown: (block) => {
    const body = inlineContentToMarkdown(block.content);
    if (body.length === 0) return EMPTY_PARAGRAPH_SENTINEL;
    return escapeBlockOpener(body);
  },
  fromMarkdown: (node) => {
    if (node.type !== "paragraph") return null;
    const children = node.children;
    if (isEmptyParagraphSentinel(children)) {
      return {
        id: "",
        type: "paragraph",
        props: {},
        content: [],
        children: [],
      } as unknown as LooseBlock;
    }
    return {
      id: "",
      type: "paragraph",
      props: {},
      content: mdastInlineToBlockNote(children),
      children: [],
    } as unknown as LooseBlock;
  },
});

function isEmptyParagraphSentinel(children: readonly unknown[]): boolean {
  if (children.length !== 1) return false;
  const only = children[0] as { type?: unknown; value?: unknown };
  return only.type === "text" && only.value === EMPTY_PARAGRAPH_SENTINEL;
}

/**
 * Prefix a single backslash before the first character of a paragraph
 * body when that character would otherwise start a different block on
 * CommonMark re-parse. The inline emitter already handles escape of
 * `*`, `_`, `[`, `<`, `` ` ``; the characters handled here are the
 * block-level openers that slip through inline escape because they
 * are harmless mid-text (`>`, `-`, `+`, `#`) or whose block-meaning
 * depends on context (digits before `.` / `)`).
 *
 * Backslash-escape consumes the first character as a literal on
 * parse; the resulting mdast text node carries the original content
 * (no backslash), so `mdastInlineToBlockNote` produces the original
 * BlockNote content array without any extra handling.
 *
 * Leading-whitespace cases (4+ spaces → indented code; tab → indented
 * code) are deliberately NOT handled: they require re-escaping that
 * collides with the emphasis-boundary-whitespace handling in
 * `./inline.ts`, and BlockNote does not normally produce paragraph
 * content with leading whitespace at a run boundary.
 */
function escapeBlockOpener(md: string): string {
  // Blockquote: `>` at line start triggers regardless of following char.
  if (md.startsWith(">")) return `\\${md}`;
  // ATX heading: 1..6 `#`s followed by space or end-of-string.
  if (/^#{1,6}(\s|$)/.test(md)) return `\\${md}`;
  // Unordered list markers `-` / `+` followed by space.
  // `*` is already backslash-escaped by the inline emitter, so it
  // never reaches this point as a literal star.
  if (/^[-+]\s/.test(md)) return `\\${md}`;
  // Ordered list: one or more digits + `.` or `)` + space.
  if (/^\d+[.)]\s/.test(md)) {
    return md.replace(/^(\d+)([.)])/, "$1\\$2");
  }
  // Thematic break: a line consisting only of 3+ hyphens (and
  // optional trailing whitespace). `*` / `_` versions are already
  // handled by inline escape.
  if (/^-{3,}\s*$/.test(md)) return `\\${md}`;
  return md;
}
