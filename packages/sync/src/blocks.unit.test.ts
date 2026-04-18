/**
 * `seedBlocks` / `readBlocks` — BlockNote ↔ Y.Doc conversion tests.
 *
 * Proves the ephemeral-editor path writes structure onto the Yjs
 * fragment and reads it back. The round-trip test here is the local
 * equivalent of the ADR 0013 per-block property test: for the two
 * core block types this slice ships (heading, paragraph), what we
 * seed is what we read.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { BLOCKNOTE_FRAGMENT, type LoosePartialBlock, readBlocks, seedBlocks } from "./blocks";

/**
 * BlockNote's concrete block configs are rich-typed (each block type
 * narrows `props` / `content`), so a literal like
 * `{ type: "heading", props: { level: 1 }, content: "…" }` does not
 * directly match the wide-generic `LoosePartialBlock` used at the
 * sync-package boundary. Tests build via this helper to keep the
 * literal-object syntax without sprinkling casts.
 */
function block(b: unknown): LoosePartialBlock {
  return b as LoosePartialBlock;
}

describe("seedBlocks", () => {
  it("writes heading + paragraph blocks onto the Y.XmlFragment", () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      block({ type: "heading", props: { level: 1 }, content: "Doc title" }),
      block({ type: "paragraph", content: "" }),
    ]);
    const fragment = ydoc.getXmlFragment(BLOCKNOTE_FRAGMENT);
    expect(fragment.length).toBeGreaterThan(0);
  });

  it("refuses to run against a non-empty fragment (history-loss guard)", () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [block({ type: "paragraph", content: "first" })]);
    expect(() => seedBlocks(ydoc, [block({ type: "paragraph", content: "second" })])).toThrow(
      /non-empty Y\.XmlFragment/,
    );
  });

  it("each call makes a fresh editor (no state bleeds between seeds on different docs)", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    seedBlocks(docA, [block({ type: "paragraph", content: "A" })]);
    seedBlocks(docB, [block({ type: "paragraph", content: "B" })]);
    const a = readBlocks(docA);
    const b = readBlocks(docB);
    expect(inlineText(a)).toBe("A");
    expect(inlineText(b)).toBe("B");
  });
});

describe("readBlocks", () => {
  it("returns an empty document for a blank Y.Doc", () => {
    const ydoc = new Y.Doc();
    const blocks = readBlocks(ydoc);
    expect(blocks).toEqual([]);
  });

  it("round-trips the seeded heading + paragraph shape", () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      block({ type: "heading", props: { level: 1 }, content: "Title" }),
      block({ type: "paragraph", content: "body text" }),
    ]);
    const blocks = readBlocks(ydoc);
    expect(blocks).toHaveLength(2);
    const [h, p] = blocks;
    if (h === undefined || p === undefined) throw new Error("expected two blocks");
    expect(h.type).toBe("heading");
    expect(p.type).toBe("paragraph");
    const hProps = h.props as unknown as { level: number };
    expect(hProps.level).toBe(1);
    expect(inlineText([h])).toBe("Title");
    expect(inlineText([p])).toBe("body text");
  });

  it("projects what a second Y.Doc with the same update stream sees (CRDT merge)", () => {
    const source = new Y.Doc();
    seedBlocks(source, [block({ type: "paragraph", content: "merged" })]);
    const update = Y.encodeStateAsUpdate(source);

    const replica = new Y.Doc();
    Y.applyUpdate(replica, update);
    expect(inlineText(readBlocks(replica))).toBe("merged");
  });
});

// ── helpers ────────────────────────────────────────────────────────────

interface InlineTextNode {
  readonly type: "text";
  readonly text: string;
}

interface BlockContent {
  readonly content?: readonly unknown[];
}

function inlineText(blocks: ReadonlyArray<BlockContent>): string {
  return blocks
    .map((b) => {
      const content = b.content ?? [];
      return content
        .filter(isInlineText)
        .map((t) => t.text)
        .join("");
    })
    .join("\n");
}

function isInlineText(node: unknown): node is InlineTextNode {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    (node as { type: unknown }).type === "text" &&
    "text" in node &&
    typeof (node as { text: unknown }).text === "string"
  );
}
