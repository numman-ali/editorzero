/**
 * `editorzero:core/heading` — BlockTypeSpec (architecture.md §16.5,
 * ADR 0013).
 *
 * Round-trip contract for BlockNote's `heading` block. mdast's
 * `heading` node carries a `depth ∈ [1..6]` which is what BlockNote
 * calls `level`. Lossless on the same inline style subset as
 * `editorzero:core/paragraph` (see `./inline.ts`).
 *
 * Block-level props in scope: `level`. BlockNote's default heading
 * also ships `isToggleable`, `textColor`, `backgroundColor`,
 * `textAlignment` — same rationale as paragraph: those UI props
 * don't survive CommonMark, so they're outside this spec's lossless
 * claim and the property harness fuzzes only heading blocks with
 * non-level props at defaults.
 *
 * The "doc title" convention: an editorzero doc's title is the first
 * heading with `level = 1`. There's no separate `title` block type;
 * `doc.create` seeds one by inserting a heading-1 at index 0, and
 * `doc.rename` updates its content via `ctx.transact`
 * (architecture.md §1034). The unified title-is-a-heading approach
 * avoids a custom TipTap node and keeps the schema shape inside
 * BlockNote's defaults.
 */

import type { Block, BlockSchema, InlineContentSchema, StyleSchema } from "@blocknote/core";
import { z } from "zod";

import { type BlockTypeSpec, createBlockTypeSpec } from "../kernel";
import { inlineContentToMarkdown, mdastInlineToBlockNote } from "./inline";

export const HEADING_TYPE = "editorzero:core/heading" as const;

const headingAttributes = z.object({
  level: z.number().int().min(1).max(6),
});

export type HeadingAttributes = z.infer<typeof headingAttributes>;

type LooseBlock = Block<BlockSchema, InlineContentSchema, StyleSchema>;

export const heading: BlockTypeSpec<HeadingAttributes> = createBlockTypeSpec({
  type: HEADING_TYPE,
  tier: "lossless",
  attributes: headingAttributes,
  toMarkdown: (block) => {
    const level = extractHeadingLevel(block);
    const prefix = "#".repeat(level);
    const body = inlineContentToMarkdown(block.content);
    return `${prefix} ${body}`;
  },
  fromMarkdown: (node) => {
    if (node.type !== "heading") return null;
    return {
      id: "",
      type: "heading",
      props: { level: node.depth },
      content: mdastInlineToBlockNote(node.children),
      children: [],
    } as unknown as LooseBlock;
  },
});

function extractHeadingLevel(block: LooseBlock): 1 | 2 | 3 | 4 | 5 | 6 {
  const props = block.props as { level?: unknown };
  const raw = props.level;
  if (typeof raw !== "number" || raw < 1 || raw > 6 || !Number.isInteger(raw)) {
    throw new Error(
      `heading.toMarkdown: block.props.level must be an integer in [1, 6]; got ${String(raw)}`,
    );
  }
  return raw as 1 | 2 | 3 | 4 | 5 | 6;
}
