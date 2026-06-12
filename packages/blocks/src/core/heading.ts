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

import { z } from "zod";

import { type BlockTypeSpec, createBlockTypeSpec } from "../kernel";
import type { Block } from "../model";
import { inlineContentToMarkdown, mdastInlineToStyledText } from "./inline";

export const HEADING_TYPE = "editorzero:core/heading" as const;

/**
 * `level` defaults to 1 so a retype (`doc.update` patching a paragraph
 * to `type: "heading"` without props) lands on the same level the
 * owned Tiptap node defaults to — applier and editor agree by
 * construction.
 */
export const headingAttributes = z.object({
  level: z.number().int().min(1).max(6).default(1),
});

export type HeadingAttributes = z.infer<typeof headingAttributes>;

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
      content: mdastInlineToStyledText(node.children),
      children: [],
    };
  },
});

function extractHeadingLevel(block: Block): 1 | 2 | 3 | 4 | 5 | 6 {
  const raw = block.props["level"];
  if (raw === 1 || raw === 2 || raw === 3 || raw === 4 || raw === 5 || raw === 6) {
    return raw;
  }
  throw new Error(
    `heading.toMarkdown: block.props.level must be an integer in [1, 6]; got ${String(raw)}`,
  );
}
