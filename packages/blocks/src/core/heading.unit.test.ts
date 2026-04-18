/**
 * `editorzero:core/heading` — per-spec unit tests. Inline-style
 * handling is the same machinery as paragraph and is covered over
 * there; this file focuses on the level prop and the heading/mdast
 * depth mapping.
 */

import type {
  Block,
  BlockSchema,
  InlineContentSchema,
  StyledText,
  StyleSchema,
} from "@blocknote/core";
import { describe, expect, it } from "vitest";

import { HEADING_TYPE, heading } from "./heading";

type LooseBlock = Block<BlockSchema, InlineContentSchema, StyleSchema>;

function textNode(text: string, styles: Record<string, boolean> = {}): StyledText<StyleSchema> {
  return { type: "text", text, styles } as unknown as StyledText<StyleSchema>;
}

function makeHeading(level: number, content: StyledText<StyleSchema>[]): LooseBlock {
  return {
    id: "",
    type: "heading",
    props: { level },
    content,
    children: [],
  } as unknown as LooseBlock;
}

describe("heading.toMarkdown", () => {
  it.each([1, 2, 3, 4, 5, 6] as const)("emits %i `#` characters for level %i", (level) => {
    const md = heading.toMarkdown(makeHeading(level, [textNode("Title")]));
    expect(md).toBe(`${"#".repeat(level)} Title`);
  });

  it("applies the inline style emitters inside the heading body", () => {
    const md = heading.toMarkdown(makeHeading(2, [textNode("bold", { bold: true })]));
    expect(md).toBe("## **bold**");
  });

  it("throws when the level prop is missing or out of range", () => {
    expect(() => heading.toMarkdown(makeHeading(0, [textNode("x")]))).toThrow(
      /props.level must be an integer in \[1, 6\]/,
    );
    expect(() => heading.toMarkdown(makeHeading(7, [textNode("x")]))).toThrow(
      /props.level must be an integer/,
    );
    expect(() =>
      heading.toMarkdown({
        id: "",
        type: "heading",
        props: {},
        content: [],
        children: [],
      } as unknown as LooseBlock),
    ).toThrow(/props.level must be an integer/);
  });
});

describe("heading.fromMarkdown", () => {
  it("returns null when the mdast node is not a heading", () => {
    const out = heading.fromMarkdown({ type: "paragraph", children: [] } as never);
    expect(out).toBeNull();
  });

  it.each([1, 2, 3, 4, 5, 6] as const)("maps mdast depth=%i to props.level=%i", (depth) => {
    const out = heading.fromMarkdown({
      type: "heading",
      depth,
      children: [{ type: "text", value: "T" }],
    } as never) as LooseBlock;
    expect((out.props as unknown as { level: number }).level).toBe(depth);
    expect(out.content).toEqual([{ type: "text", text: "T", styles: {} }]);
  });
});

describe("heading round-trip", () => {
  it("depth + plain text is a fixed point through fromMarkdown ∘ toMarkdown", () => {
    const start = makeHeading(3, [textNode("hi")]);
    const md = heading.toMarkdown(start);
    expect(md).toBe("### hi");
    // Simulate the mdast parser's output: `### hi` parses to
    // { type: "heading", depth: 3, children: [{ type: "text", value: "hi" }] }
    const parsed = {
      type: "heading",
      depth: 3,
      children: [{ type: "text", value: "hi" }],
    } as never;
    const roundtripped = heading.fromMarkdown(parsed) as Block;
    expect((roundtripped.props as { level: number }).level).toBe(3);
    expect(roundtripped.content).toEqual(start.content);
  });
});

describe("heading registry metadata", () => {
  it("declares the expected type + tier", () => {
    expect(heading.type).toBe(HEADING_TYPE);
    expect(heading.tier).toBe("lossless");
  });

  it("validates level via the attributes zod schema", () => {
    expect(heading.attributes.safeParse({ level: 3 }).success).toBe(true);
    expect(heading.attributes.safeParse({ level: 0 }).success).toBe(false);
    expect(heading.attributes.safeParse({ level: 7 }).success).toBe(false);
    expect(heading.attributes.safeParse({ level: 1.5 }).success).toBe(false);
  });
});
