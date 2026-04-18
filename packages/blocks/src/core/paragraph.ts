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
  toMarkdown: (block) => inlineContentToMarkdown(block.content),
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
