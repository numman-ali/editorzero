/**
 * `./inline.ts` — dedicated inline-emitter + inline-importer tests.
 *
 * Covers the round-trip hazards that were invisible to the
 * paragraph-level example tests: CommonMark quirks around emphasis
 * boundary whitespace, code-span fences around embedded backticks,
 * and plain-text angle brackets that would otherwise trigger
 * raw-HTML / autolink parsing.
 */

import { describe, expect, it } from "vitest";

import { inlineContentToMarkdown, mdastInlineToStyledText } from "./inline";

describe("inlineContentToMarkdown — emphasis boundary whitespace", () => {
  it("moves trailing whitespace outside bold delimiters", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: "bold ", styles: { bold: true } }]);
    expect(md).toBe("**bold** ");
  });

  it("moves leading whitespace outside italic delimiters", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: " note", styles: { italic: true } }]);
    expect(md).toBe(" *note*");
  });

  it("moves whitespace outside both delimiters when bold+italic overlap", () => {
    const md = inlineContentToMarkdown([
      { type: "text", text: " both ", styles: { bold: true, italic: true } },
    ]);
    expect(md).toBe(" ***both*** ");
  });

  it("emits plain whitespace (no delimiters) when the run is whitespace-only", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: "   ", styles: { bold: true } }]);
    expect(md).toBe("   ");
  });
});

describe("inlineContentToMarkdown — code-span fence choice", () => {
  it("uses a single backtick when the content has no backticks", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: "foo", styles: { code: true } }]);
    expect(md).toBe("`foo`");
  });

  it("uses a longer fence when the content contains a backtick", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: "a`b", styles: { code: true } }]);
    expect(md).toBe("``a`b``");
  });

  it("uses a fence at least (max_run + 1) long for multi-backtick runs", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: "x``y", styles: { code: true } }]);
    expect(md).toBe("```x``y```");
  });

  it("pads with a single space on both sides when content starts with a backtick", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: "`foo", styles: { code: true } }]);
    // Fence length = 2 (max run of 1 + 1). Padding prevents CommonMark
    // from reading the leading backtick as part of the closing fence.
    expect(md).toBe("`` `foo ``");
  });

  it("pads when content ends with a backtick", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: "foo`", styles: { code: true } }]);
    expect(md).toBe("`` foo` ``");
  });
});

describe("inlineContentToMarkdown — angle-bracket escape", () => {
  it("escapes `<` so CommonMark does not parse the text as raw HTML", () => {
    const md = inlineContentToMarkdown([{ type: "text", text: "<b>hi</b>", styles: {} }]);
    expect(md).toBe("\\<b\\>hi\\</b\\>");
  });

  it("escapes `<` and `>` around an autolink-shaped URL", () => {
    const md = inlineContentToMarkdown([
      { type: "text", text: "see <https://example.com>", styles: {} },
    ]);
    expect(md).toBe("see \\<https://example.com\\>");
  });
});

describe("mdastInlineToStyledText — canonicalization (merge adjacent same-style)", () => {
  it("merges two adjacent plain text nodes into one", () => {
    const out = mdastInlineToStyledText([
      { type: "text", value: "foo" },
      { type: "text", value: "bar" },
    ]);
    expect(out).toEqual([{ type: "text", text: "foobar", styles: {} }]);
  });

  it("keeps runs separate when their style bags differ", () => {
    const out = mdastInlineToStyledText([
      { type: "text", value: " " },
      { type: "strong", children: [{ type: "text", value: "bold" }] },
      { type: "text", value: " " },
    ]);
    // Outer spaces have empty styles; bold has { bold: true }. No merge.
    expect(out).toEqual([
      { type: "text", text: " ", styles: {} },
      { type: "text", text: "bold", styles: { bold: true } },
      { type: "text", text: " ", styles: {} },
    ]);
  });

  it("flattens a nested strong(emphasis) into a single style bag", () => {
    const out = mdastInlineToStyledText([
      {
        type: "strong",
        children: [{ type: "emphasis", children: [{ type: "text", value: "x" }] }],
      },
    ]);
    expect(out).toEqual([{ type: "text", text: "x", styles: { bold: true, italic: true } }]);
  });

  it("merges adjacent styled runs that share the same styles after walk", () => {
    const out = mdastInlineToStyledText([
      { type: "strong", children: [{ type: "text", value: "hi " }] },
      { type: "strong", children: [{ type: "text", value: "there" }] },
    ]);
    expect(out).toEqual([{ type: "text", text: "hi there", styles: { bold: true } }]);
  });

  it("maps inlineCode to a code-styled text node", () => {
    const out = mdastInlineToStyledText([{ type: "inlineCode", value: "x" }]);
    expect(out).toEqual([{ type: "text", text: "x", styles: { code: true } }]);
  });
});

// ── Simulated round-trip (emit, then feed the result back as mdast) ──────
//
// These tests call `inlineContentToMarkdown` to emit Markdown, then
// hand-construct the mdast shape a real CommonMark parser would
// produce for that Markdown, and confirm `mdastInlineToStyledText`
// recovers the canonical input. The hand-constructed mdast exercises
// the escape-consumption behaviour (`\<` → text value `<`, etc.)
// that a real parser owns; the expected shapes are what
// github.com/remarkjs/remark 15.x produces for each input (verified
// by reading the CommonMark spec — we don't pull in remark here to
// keep the test deps minimal; the property harness lands in Phase 3).

describe("inline simulated round-trip", () => {
  it("plain text with angle brackets survives", () => {
    const start = [{ type: "text" as const, text: "<b>", styles: {} as Record<string, boolean> }];
    const md = inlineContentToMarkdown(start);
    expect(md).toBe("\\<b\\>");
    // After CommonMark consumes the escapes, mdast text value has
    // the raw angle brackets back.
    const roundtripped = mdastInlineToStyledText([{ type: "text", value: "<b>" }]);
    expect(roundtripped).toEqual(start);
  });

  it("code span with embedded backtick round-trips via (max+1)-fence", () => {
    const start = [
      { type: "text" as const, text: "a`b", styles: { code: true } as Record<string, boolean> },
    ];
    const md = inlineContentToMarkdown(start);
    expect(md).toBe("``a`b``");
    // CommonMark parses ``a`b`` as inlineCode with value `a\`b`.
    const roundtripped = mdastInlineToStyledText([{ type: "inlineCode", value: "a`b" }]);
    expect(roundtripped).toEqual(start);
  });
});
