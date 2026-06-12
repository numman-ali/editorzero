/**
 * `editorzero:core/paragraph` — per-spec unit tests.
 *
 * The full property-based fidelity harness lands in Phase 3; this
 * file covers the example-based cases that pin the shape of
 * `toMarkdown` / `fromMarkdown` and exercise the inline style
 * coverage (bold, italic, code). Composition is tested once —
 * `fromMarkdown(toMarkdown(x))` is deep-equal to `x` for a
 * representative styled input — because that is the invariant the
 * spec actually claims.
 */

import { describe, expect, it } from "vitest";

import type { Block, StyledText } from "../model";

import { PARAGRAPH_TYPE, paragraph } from "./paragraph";

function textNode(text: string, styles: Record<string, boolean> = {}): StyledText {
  return { type: "text", text, styles };
}

/** Narrow `fromMarkdown`'s nullable return for assertion ergonomics. */
function mustBlock(out: Block | null): Block {
  if (out === null) throw new Error("fromMarkdown returned null");
  return out;
}

function makeParagraph(content: StyledText[]): Block {
  return {
    id: "",
    type: "paragraph",
    props: {},
    content,
    children: [],
  };
}

describe("paragraph.toMarkdown", () => {
  it("emits the text verbatim for a plain styled-text content", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("hello world")]));
    expect(md).toBe("hello world");
  });

  it("wraps bold text in `**`", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("hi", { bold: true })]));
    expect(md).toBe("**hi**");
  });

  it("wraps italic text in `*`", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("hi", { italic: true })]));
    expect(md).toBe("*hi*");
  });

  it("nests italic inside bold — `**` outside, `*` inside (matches mdast's canonical order)", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("hi", { bold: true, italic: true })]));
    expect(md).toBe("***hi***");
  });

  it("emits code-styled text with backticks and no additional wrapping", () => {
    // `inlineCode` is a leaf in mdast, so co-styles are dropped on the
    // emit side. Round-trip via a parser won't re-produce the bold
    // anyway; keeping the emitter in sync with that reality is what
    // makes the round-trip a fixed point.
    const md = paragraph.toMarkdown(makeParagraph([textNode("x", { code: true, bold: true })]));
    expect(md).toBe("`x`");
  });

  it("escapes CommonMark-significant glyphs in plain text", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("a*b_c[d]")]));
    expect(md).toBe("a\\*b\\_c\\[d\\]");
  });

  it("concatenates a mixed run of styled text items", () => {
    const md = paragraph.toMarkdown(
      makeParagraph([
        textNode("plain "),
        textNode("bold", { bold: true }),
        textNode(" and "),
        textNode("ital", { italic: true }),
      ]),
    );
    expect(md).toBe("plain **bold** and *ital*");
  });

  it("emits the empty string for an empty content array (outside lossless tier)", () => {
    // CommonMark has no spelling for an empty paragraph: any invented
    // sentinel (NBSP, ZWSP, etc.) collides with legitimate content
    // that happens to contain those code points, which is worse than
    // the lossy empty-string behaviour. The document-level serializer
    // handles empty-paragraph spacing by joining non-empty paragraphs
    // with blank lines — this block-level carve-out is what lets that
    // document-level logic own the correct behaviour. See paragraph.ts
    // file header for the full rationale.
    const md = paragraph.toMarkdown(makeParagraph([]));
    expect(md).toBe("");
  });

  it("escapes a leading `>` to prevent blockquote parse", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("> quoted")]));
    expect(md).toBe("\\> quoted");
  });

  it("escapes a leading `#` (ATX heading opener)", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("# not heading")]));
    expect(md).toBe("\\# not heading");
  });

  it("escapes a leading `-` followed by space (unordered list marker)", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("- bullet")]));
    expect(md).toBe("\\- bullet");
  });

  it("escapes a leading `+` followed by space (unordered list marker)", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("+ bullet")]));
    expect(md).toBe("\\+ bullet");
  });

  it("escapes the `.` after a leading digit run (ordered list marker)", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("1. install")]));
    expect(md).toBe("1\\. install");
  });

  it("escapes the `)` after a leading digit run (ordered list marker)", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("42) answer")]));
    expect(md).toBe("42\\) answer");
  });

  it("escapes a bare `---` line (thematic break opener)", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("---")]));
    expect(md).toBe("\\---");
  });

  it("escapes a blockquote marker preceded by 1–3 leading spaces", () => {
    // CommonMark still recognizes `> ` as a blockquote opener after
    // up to 3 leading spaces; the escape has to land on the `>` while
    // preserving the indent verbatim.
    const md = paragraph.toMarkdown(makeParagraph([textNode("   > quoted")]));
    expect(md).toBe("   \\> quoted");
  });

  it("escapes an ordered-list marker preceded by leading spaces", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode(" 1. item")]));
    expect(md).toBe(" 1\\. item");
  });

  it("escapes an ATX heading marker preceded by 2 leading spaces", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("  ## still a paragraph")]));
    expect(md).toBe("  \\## still a paragraph");
  });

  it("does not add a block-level escape after 4+ leading spaces (those become indented code; out of scope)", () => {
    // 4+ spaces is CommonMark's indented-code trigger, which this
    // serializer does NOT handle — escaping here would collide with
    // emphasis boundary-whitespace handling. Documented in
    // `paragraph.ts` as an explicit carve-out; the property harness
    // will not fuzz this shape. The `>` backslash comes from the
    // inline escape set, not the block-opener escaper.
    const md = paragraph.toMarkdown(makeParagraph([textNode("    > not escaped")]));
    expect(md).toBe("    \\> not escaped");
  });

  it("leaves a normal paragraph start unchanged", () => {
    const md = paragraph.toMarkdown(makeParagraph([textNode("hello world")]));
    expect(md).toBe("hello world");
  });

  it("throws when an inline item is not a StyledText node (out-of-scope shape)", () => {
    const bogus = [{ type: "link", href: "x", content: [] }] as unknown as StyledText[];
    expect(() => paragraph.toMarkdown(makeParagraph(bogus))).toThrow(
      /unsupported inline item shape; expected StyledText, got link/,
    );
  });

  it("throws with the typeof in the error when the inline item isn't a typed object", () => {
    // Non-object inline item (e.g., a stray string) exercises the
    // fallback branch of the error message — `typeof item` instead of
    // `item.type`. Real callers never hit this; the branch is the
    // defensive failure mode if an upstream change starts feeding
    // non-object inline data through.
    const bogus = ["not-an-object"] as unknown as StyledText[];
    expect(() => paragraph.toMarkdown(makeParagraph(bogus))).toThrow(
      /unsupported inline item shape; expected StyledText, got string/,
    );
  });
});

describe("paragraph.fromMarkdown", () => {
  it("returns null when the mdast node is not a paragraph", () => {
    const out = paragraph.fromMarkdown({ type: "heading", depth: 1, children: [] } as never);
    expect(out).toBeNull();
  });

  it("builds a plain-text paragraph from an mdast paragraph", () => {
    const out = paragraph.fromMarkdown({
      type: "paragraph",
      children: [{ type: "text", value: "hi" }],
    } as never);
    expect(out).not.toBeNull();
    const block = mustBlock(out);
    expect(block.type).toBe("paragraph");
    expect(block.content).toEqual([{ type: "text", text: "hi", styles: {} }]);
  });

  it("carries strong → bold on the inner text nodes", () => {
    const out = paragraph.fromMarkdown({
      type: "paragraph",
      children: [{ type: "strong", children: [{ type: "text", value: "x" }] }],
    } as never);
    const block = mustBlock(out);
    expect(block.content).toEqual([{ type: "text", text: "x", styles: { bold: true } }]);
  });

  it("composes strong+emphasis styles on the flattened text", () => {
    const out = paragraph.fromMarkdown({
      type: "paragraph",
      children: [
        {
          type: "strong",
          children: [{ type: "emphasis", children: [{ type: "text", value: "y" }] }],
        },
      ],
    } as never);
    const block = mustBlock(out);
    expect(block.content).toEqual([
      { type: "text", text: "y", styles: { bold: true, italic: true } },
    ]);
  });

  it("maps inlineCode to code-styled text", () => {
    const out = paragraph.fromMarkdown({
      type: "paragraph",
      children: [{ type: "inlineCode", value: "x" }],
    } as never);
    const block = mustBlock(out);
    expect(block.content).toEqual([{ type: "text", text: "x", styles: { code: true } }]);
  });
});

describe("paragraph round-trip (fromMarkdown(toMarkdown) is the fixed point)", () => {
  it("plain text", () => {
    const start = makeParagraph([textNode("hello")]);
    const md = paragraph.toMarkdown(start);
    const roundtripped = paragraph.fromMarkdown({
      type: "paragraph",
      children: [{ type: "text", value: md }],
    } as never);
    expect(mustBlock(roundtripped).content).toEqual(start.content);
  });

  it("text starting with a blockquote character", () => {
    // `toMarkdown` escapes the leading `>`. CommonMark consumes the
    // backslash and yields a text node with the raw `> quoted`.
    const start = makeParagraph([textNode("> quoted")]);
    paragraph.toMarkdown(start);
    const roundtripped = paragraph.fromMarkdown({
      type: "paragraph",
      children: [{ type: "text", value: "> quoted" }],
    } as never);
    expect(mustBlock(roundtripped).content).toEqual(start.content);
  });

  it("text starting with an ordered-list marker", () => {
    const start = makeParagraph([textNode("1. install")]);
    paragraph.toMarkdown(start);
    const roundtripped = paragraph.fromMarkdown({
      type: "paragraph",
      children: [{ type: "text", value: "1. install" }],
    } as never);
    expect(mustBlock(roundtripped).content).toEqual(start.content);
  });
});

describe("paragraph registry metadata", () => {
  it("declares the expected type + tier", () => {
    expect(paragraph.type).toBe(PARAGRAPH_TYPE);
    expect(paragraph.tier).toBe("lossless");
  });
});
