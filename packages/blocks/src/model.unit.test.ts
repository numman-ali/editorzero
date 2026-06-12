/**
 * Owned block model — `normalizeContent` / `materializeBlock` unit
 * tests. The canonicalization rules here are load-bearing for the
 * hash + diff layers: one spelling per content state, loud throws on
 * shapes outside the v1 inline tier.
 */

import { describe, expect, it } from "vitest";

import { materializeBlock, normalizeContent, parseBlocks } from "./model";

describe("normalizeContent", () => {
  it("maps undefined and the empty string to []", () => {
    expect(normalizeContent(undefined)).toEqual([]);
    expect(normalizeContent("")).toEqual([]);
  });

  it("maps a non-empty string to one unstyled run", () => {
    expect(normalizeContent("Title")).toEqual([{ type: "text", text: "Title", styles: {} }]);
  });

  it("passes through styled runs, keeping only true style keys", () => {
    expect(
      normalizeContent([
        { type: "text", text: "a", styles: { bold: true, italic: false } },
        { type: "text", text: "b", styles: {} },
      ]),
    ).toEqual([
      { type: "text", text: "a", styles: { bold: true } },
      { type: "text", text: "b", styles: {} },
    ]);
  });

  it("drops empty-text runs (they carry nothing)", () => {
    expect(
      normalizeContent([
        { type: "text", text: "", styles: { bold: true } },
        { type: "text", text: "x", styles: {} },
      ]),
    ).toEqual([{ type: "text", text: "x", styles: {} }]);
  });

  it("throws loud on inline shapes outside the v1 tier", () => {
    expect(() => normalizeContent([{ type: "link", href: "https://x" }])).toThrow();
    expect(() => normalizeContent(42)).toThrow();
    expect(() =>
      normalizeContent([{ type: "text", text: "x", styles: { underline: true } }]),
    ).toThrow();
  });
});

describe("materializeBlock", () => {
  it("fills defaults: empty props, normalized content, no children", () => {
    expect(materializeBlock({ type: "paragraph" }, "id-1")).toEqual({
      id: "id-1",
      type: "paragraph",
      props: {},
      content: [],
      children: [],
    });
  });

  it("copies props and applies the string-content shorthand", () => {
    const block = materializeBlock({ type: "heading", props: { level: 2 }, content: "T" }, "id-2");
    expect(block).toEqual({
      id: "id-2",
      type: "heading",
      props: { level: 2 },
      content: [{ type: "text", text: "T", styles: {} }],
      children: [],
    });
  });
});

describe("parseBlocks", () => {
  const wireBlock = {
    id: "018f0000-0000-7000-8000-0000000000b1",
    type: "heading",
    props: { level: 2 },
    content: [{ type: "text", text: "T", styles: { bold: true } }],
    children: [],
  };

  it("round-trips a persisted block list and re-canonicalizes content", () => {
    const noisy = {
      ...wireBlock,
      // `bold: false` and an empty run are non-canonical spellings the
      // parser must collapse — the browser's hash has to match the
      // server's.
      content: [
        { type: "text", text: "T", styles: { bold: true, italic: false } },
        { type: "text", text: "", styles: {} },
      ],
    };
    expect(parseBlocks([noisy])).toEqual([
      {
        id: wireBlock.id,
        type: "heading",
        props: { level: 2 },
        content: [{ type: "text", text: "T", styles: { bold: true } }],
        children: [],
      },
    ]);
  });

  it("throws loud on unknown keys, non-empty children, and alien inline shapes", () => {
    expect(() => parseBlocks([{ ...wireBlock, surprise: 1 }])).toThrow();
    expect(() => parseBlocks([{ ...wireBlock, children: [wireBlock] }])).toThrow();
    expect(() =>
      parseBlocks([{ ...wireBlock, content: [{ type: "link", href: "https://x" }] }]),
    ).toThrow();
    expect(() => parseBlocks([null])).toThrow();
  });
});
