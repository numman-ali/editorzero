/**
 * `seedBlocks` / `readBlocks` / `writeBlocks` — owned layer ⇄ Y.Doc
 * bridge tests (ADR 0038).
 *
 * Proves the DOM-free path writes structure onto the Yjs fragment and
 * reads it back. The round-trip test here is the local equivalent of
 * the ADR 0013 per-block property test: for the two core block types
 * this slice ships (heading, paragraph), what we write is what we
 * read — ids, props, styled runs and all. The `writeBlocks` describe
 * additionally pins the two `updateYFragment` semantics the write
 * path leans on (one update event per call; equality-matched children
 * keep their Yjs identity).
 */

import type { Block, StyledText } from "@editorzero/blocks";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { DOC_FRAGMENT, readBlocks, type SeedBlock, seedBlocks, writeBlocks } from "./blocks";

let nextId = 0;
function mintTestId(): string {
  nextId += 1;
  return `018f0000-0000-7000-8000-${String(nextId).padStart(12, "0")}`;
}

function seed(b: Omit<SeedBlock, "id"> & { id?: string }): SeedBlock {
  return { id: b.id ?? mintTestId(), type: b.type, props: b.props, content: b.content };
}

function run(text: string, styles: StyledText["styles"] = {}): StyledText {
  return { type: "text", text, styles };
}

function mustBlock(block: Block | undefined): Block {
  if (block === undefined) throw new Error("expected a block");
  return block;
}

describe("seedBlocks", () => {
  it("writes heading + paragraph blocks onto the Y.XmlFragment", () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      seed({ type: "heading", props: { level: 1 }, content: "Doc title" }),
      seed({ type: "paragraph", content: "" }),
    ]);
    const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
    expect(fragment.length).toBe(2);
  });

  it("refuses to run against a non-empty fragment (history-loss guard)", () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [seed({ type: "paragraph", content: "first" })]);
    expect(() => seedBlocks(ydoc, [seed({ type: "paragraph", content: "second" })])).toThrow(
      /non-empty Y\.XmlFragment/,
    );
  });

  it("honours the caller's pre-minted block ids (audit invariant 3a)", () => {
    const ydoc = new Y.Doc();
    const titleId = mintTestId();
    const bodyId = mintTestId();
    seedBlocks(ydoc, [
      seed({ id: titleId, type: "heading", props: { level: 1 }, content: "T" }),
      seed({ id: bodyId, type: "paragraph", content: "b" }),
    ]);
    expect(readBlocks(ydoc).map((b) => b.id)).toEqual([titleId, bodyId]);
  });
});

describe("readBlocks", () => {
  it("returns an empty document for a blank Y.Doc", () => {
    const ydoc = new Y.Doc();
    expect(readBlocks(ydoc)).toEqual([]);
  });

  it("round-trips ids, props, and styled runs exactly", () => {
    const ydoc = new Y.Doc();
    const blocks: SeedBlock[] = [
      seed({ type: "heading", props: { level: 3 }, content: "Title" }),
      seed({
        type: "paragraph",
        content: [
          run("plain "),
          run("bold", { bold: true }),
          run("both", { bold: true, italic: true }),
        ],
      }),
      seed({ type: "paragraph", content: [run("code", { code: true })] }),
      seed({ type: "paragraph", content: "" }),
    ];
    seedBlocks(ydoc, blocks);
    const out = readBlocks(ydoc);
    expect(out).toEqual([
      {
        id: blocks[0]?.id,
        type: "heading",
        props: { level: 3 },
        content: [run("Title")],
        children: [],
      },
      {
        id: blocks[1]?.id,
        type: "paragraph",
        props: {},
        content: [
          run("plain "),
          run("bold", { bold: true }),
          run("both", { bold: true, italic: true }),
        ],
        children: [],
      },
      {
        id: blocks[2]?.id,
        type: "paragraph",
        props: {},
        content: [run("code", { code: true })],
        children: [],
      },
      { id: blocks[3]?.id, type: "paragraph", props: {}, content: [], children: [] },
    ]);
  });

  it("throws loud on a persisted block without an id (written outside the owned path)", () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
    fragment.insert(0, [new Y.XmlElement("paragraph")]);
    expect(() => readBlocks(ydoc)).toThrow(/without an id/);
  });

  it("projects what a second Y.Doc with the same update stream sees (CRDT merge)", () => {
    const source = new Y.Doc();
    seedBlocks(source, [seed({ type: "paragraph", content: "merged" })]);
    const update = Y.encodeStateAsUpdate(source);

    const replica = new Y.Doc();
    Y.applyUpdate(replica, update);
    expect(readBlocks(replica).map((b) => b.content)).toEqual([[run("merged")]]);
  });
});

describe("writeBlocks", () => {
  it("rejects an empty post-state (doc schema is block+)", () => {
    const ydoc = new Y.Doc();
    expect(() => writeBlocks(ydoc, [])).toThrow(/at least one block/);
  });

  it("commits as exactly ONE Yjs update event (one doc_updates row per tx)", () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      seed({ type: "heading", props: { level: 1 }, content: "T" }),
      seed({ type: "paragraph", content: "a" }),
    ]);
    const pre = readBlocks(ydoc);

    let updates = 0;
    ydoc.on("update", () => {
      updates += 1;
    });
    writeBlocks(ydoc, [mustBlock(pre[0]), { ...mustBlock(pre[1]), content: [run("edited")] }]);
    expect(updates).toBe(1);
  });

  it("leaves untouched blocks' Yjs identity alone (equality-matched, not rewritten)", () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      seed({ type: "heading", props: { level: 1 }, content: "T" }),
      seed({ type: "paragraph", content: "stable" }),
      seed({ type: "paragraph", content: "changing" }),
    ]);
    const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
    const stableYNode = fragment.get(1);

    const pre = readBlocks(ydoc);
    const edited = pre.map((b, i) => (i === 2 ? { ...b, content: [run("changed")] } : b));
    writeBlocks(ydoc, edited);

    // Same Y.XmlElement instance still sits at index 1 — the diff
    // matched it instead of replacing it.
    expect(fragment.get(1)).toBe(stableYNode);
    expect(readBlocks(ydoc).map((b) => b.content)).toEqual([
      [run("T")],
      [run("stable")],
      [run("changed")],
    ]);
  });

  it("replica that applies the seed + edit updates converges to the same read", () => {
    const source = new Y.Doc();
    const replica = new Y.Doc();
    source.on("update", (update: Uint8Array) => {
      Y.applyUpdate(replica, update);
    });

    seedBlocks(source, [
      seed({ type: "heading", props: { level: 1 }, content: "T" }),
      seed({ type: "paragraph", content: "v1" }),
    ]);
    const pre = readBlocks(source);
    const edited = pre.map((b, i) =>
      i === 1 ? { ...b, content: [run("v2", { bold: true })] } : b,
    );
    writeBlocks(source, edited);

    expect(readBlocks(replica)).toEqual(readBlocks(source));
  });
});
