/**
 * Block JSON ⇄ ProseMirror JSON mapping — unit + round-trip property.
 *
 * The sweep at the bottom is the load-bearing test: for generated
 * canonical block lists, `pmDocToBlocks(blocksToPmDoc(x)) ≡ x` AND the
 * PM JSON validates against the REAL compiled schema
 * (`Node.fromJSON(...).check()`), so the mapping can never emit a doc
 * the owned Tiptap schema rejects. Deterministic seeded generator —
 * house style (no fast-check dependency), failures reproduce exactly.
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import type { Block, StyledText } from "./model";
import { blocksToPmDoc, pmDocToBlocks } from "./pm";
import { getEditorSchema } from "./tiptap";

function run(text: string, styles: StyledText["styles"] = {}): StyledText {
  return { type: "text", text, styles };
}

function paragraph(id: string, content: StyledText[]): Block {
  return { id, type: "paragraph", props: {}, content, children: [] };
}

function heading(id: string, level: number, content: StyledText[]): Block {
  return { id, type: "heading", props: { level }, content, children: [] };
}

describe("blocksToPmDoc", () => {
  it("maps blocks to nodes with id attrs and style marks in fixed order", () => {
    const doc = blocksToPmDoc([
      heading("h1", 2, [run("Title")]),
      paragraph("p1", [run("plain "), run("bi", { italic: true, bold: true })]),
      paragraph("p2", []),
    ]);
    expect(doc).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { id: "h1", level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [
            { type: "text", text: "plain " },
            // bold before italic — fixed emit order keeps the projection deterministic
            { type: "text", text: "bi", marks: [{ type: "bold" }, { type: "italic" }] },
          ],
        },
        { type: "paragraph", attrs: { id: "p2" } },
      ],
    });
  });

  it("maps the unminted-id sentinel to a null attr", () => {
    const doc = blocksToPmDoc([paragraph("", [run("new")])]);
    expect(doc.content[0]?.attrs).toEqual({ id: null });
  });

  it("throws on unsupported block types, unknown props, and children", () => {
    expect(() => blocksToPmDoc([{ ...paragraph("x", []), type: "table" }])).toThrow(
      /unsupported block type "table"/,
    );
    expect(() => blocksToPmDoc([{ ...paragraph("x", []), props: { color: "red" } }])).toThrow(
      /unknown prop "color"/,
    );
    expect(() =>
      blocksToPmDoc([{ ...paragraph("x", []), children: [paragraph("y", [])] }]),
    ).toThrow(/nested blocks/);
  });
});

describe("pmDocToBlocks", () => {
  it('tolerates a missing / null id (browser-created node) as the "" sentinel', () => {
    const blocks = pmDocToBlocks({
      type: "doc",
      content: [{ type: "paragraph", attrs: { id: null }, content: [{ type: "text", text: "x" }] }],
    });
    expect(blocks).toEqual([paragraph("", [run("x")])]);
  });

  it("returns [] for a doc with no content key", () => {
    expect(pmDocToBlocks({ type: "doc" })).toEqual([]);
  });

  it("throws loud on malformed shapes", () => {
    expect(() => pmDocToBlocks(null)).toThrow(/malformed doc node/);
    expect(() => pmDocToBlocks({ type: "paragraph" })).toThrow(/expected a "doc" root/);
    expect(() => pmDocToBlocks({ type: "doc", content: "x" })).toThrow(/must be an array/);
    expect(() => pmDocToBlocks({ type: "doc", content: [{ attrs: {} }] })).toThrow(/no type/);
    expect(() => pmDocToBlocks({ type: "doc", content: [{ type: "blockquote" }] })).toThrow(
      /unsupported block node type/,
    );
    expect(() =>
      pmDocToBlocks({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "image" }] }],
      }),
    ).toThrow(/unsupported inline node/);
    expect(() =>
      pmDocToBlocks({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "x", marks: [{ type: "link" }] }],
          },
        ],
      }),
    ).toThrow(/unsupported mark type "link"/);
  });
});

// ── Round-trip property (seeded deterministic sweep) ─────────────────────

/** mulberry32 — tiny deterministic PRNG; reruns reproduce failures. */
function prng(seedInit: number): () => number {
  let seed = seedInit;
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genBlocks(rand: () => number, idPrefix: string): Block[] {
  const styleSets: StyledText["styles"][] = [
    {},
    { bold: true },
    { italic: true },
    { bold: true, italic: true },
    { code: true },
  ];
  const texts = ["a", "hello world", "Zwölf — ünïcode ✓", "x".repeat(40), "  spaced  "];
  const count = 1 + Math.floor(rand() * 5);
  const blocks: Block[] = [];
  for (let i = 0; i < count; i += 1) {
    const runCount = Math.floor(rand() * 4);
    const content: StyledText[] = [];
    let lastStyle = -1;
    for (let r = 0; r < runCount; r += 1) {
      // Adjacent runs must differ in styles to stay canonical — PM
      // merges same-marked neighbouring text nodes on the way back.
      let styleIdx = Math.floor(rand() * styleSets.length);
      if (styleIdx === lastStyle) styleIdx = (styleIdx + 1) % styleSets.length;
      lastStyle = styleIdx;
      const text = texts[Math.floor(rand() * texts.length)];
      const styles = styleSets[styleIdx];
      if (text === undefined || styles === undefined) continue;
      content.push(run(text, styles));
    }
    blocks.push(
      rand() < 0.4
        ? heading(`${idPrefix}-${i}`, 1 + Math.floor(rand() * 6), content)
        : paragraph(`${idPrefix}-${i}`, content),
    );
  }
  return blocks;
}

describe("round-trip property", () => {
  it("pmDocToBlocks ∘ blocksToPmDoc is the identity AND the PM JSON passes the real schema (100 seeded cases)", () => {
    const rand = prng(0xe21);
    const schema = getEditorSchema();
    for (let i = 0; i < 100; i += 1) {
      const blocks = genBlocks(rand, `b${i}`);
      const pmJson = blocksToPmDoc(blocks);
      const node = PmNode.fromJSON(schema, pmJson);
      node.check(); // throws if the mapping emitted anything the schema rejects
      expect(pmDocToBlocks(node.toJSON())).toEqual(blocks);
    }
  });
});
