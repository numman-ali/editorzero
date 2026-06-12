/**
 * `setDocTitle` — unit test covers the title-slot rule branches.
 *
 * Runs in plain Y.Doc land (no HocuspocusSync, no SQL, no DOM since
 * ADR 0038). The rule itself: block 0 is heading-1 → update in place;
 * block 0 is a paragraph → insert heading-1 at 0; block 0 is
 * heading-2 → insert heading-1 at 0; empty doc → the title becomes
 * the only block.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { readBlocks, type SeedBlock, seedBlocks } from "./blocks";
import { setDocTitle } from "./set-title";

let nextId = 0;
function seed(b: Omit<SeedBlock, "id">): SeedBlock {
  nextId += 1;
  return {
    id: `018f0000-0000-7000-8000-${String(nextId).padStart(12, "0")}`,
    type: b.type,
    props: b.props,
    content: b.content,
  };
}

function summarise(
  blocks: ReadonlyArray<{
    type: string;
    props: Readonly<Record<string, unknown>>;
    content: unknown;
  }>,
): Array<{ type: string; level?: number; text: string }> {
  return blocks.map((b) => {
    const parts = Array.isArray(b.content) ? (b.content as ReadonlyArray<{ text?: unknown }>) : [];
    const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    const level = b.props["level"];
    return typeof level === "number" ? { type: b.type, level, text } : { type: b.type, text };
  });
}

describe("setDocTitle", () => {
  it("updates an existing heading-1 at index 0 in place (preserves block identity)", () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      seed({ type: "heading", props: { level: 1 }, content: "Old Title" }),
      seed({ type: "paragraph", content: "body" }),
    ]);

    // Capture pre-rename block IDs. Identity-stable rename lets
    // downstream refs (audit seed_blocks, mentions) survive — a
    // regression that silently re-inserted block 0 would bump its id
    // and this assertion would catch it.
    const originalIds = readBlocks(ydoc).map((b) => b.id);

    setDocTitle(ydoc, "New Title");

    const after = summarise(readBlocks(ydoc));
    // Heading stays at index 0 with updated text + level-1 untouched.
    expect(after[0]).toEqual({ type: "heading", level: 1, text: "New Title" });
    // Body paragraph survives.
    expect(after[1]).toEqual({ type: "paragraph", text: "body" });

    const afterIds = readBlocks(ydoc).map((b) => b.id);
    expect(afterIds[0]).toBe(originalIds[0]);
    expect(afterIds[1]).toBe(originalIds[1]);
  });

  it("inserts a heading-1 at index 0 when block 0 is a paragraph (non-title slot)", () => {
    // Shape a v1 `doc.create` never produces, but a direct fragment
    // mutation (agent-crafted Y.Doc, legacy import) could. The rule:
    // recover the canonical layout by inserting heading-1 before the
    // existing block 0.
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      seed({ type: "paragraph", content: "body first" }),
      seed({ type: "paragraph", content: "body second" }),
    ]);

    setDocTitle(ydoc, "Recovered Title");

    const after = summarise(readBlocks(ydoc));
    expect(after[0]).toEqual({ type: "heading", level: 1, text: "Recovered Title" });
    expect(after[1]).toEqual({ type: "paragraph", text: "body first" });
    expect(after[2]).toEqual({ type: "paragraph", text: "body second" });
  });

  it("inserts a heading-1 at index 0 when block 0 is a heading with level !== 1", () => {
    // Heading present but wrong level — title convention is
    // specifically `level === 1`, so a level-2 block at index 0 does
    // not count as the title slot.
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      seed({ type: "heading", props: { level: 2 }, content: "Section" }),
      seed({ type: "paragraph", content: "body" }),
    ]);

    setDocTitle(ydoc, "Actual Title");

    const after = summarise(readBlocks(ydoc));
    expect(after[0]).toEqual({ type: "heading", level: 1, text: "Actual Title" });
    // The level-2 heading survives, demoted one slot — no silent
    // coercion of its level.
    expect(after[1]).toEqual({ type: "heading", level: 2, text: "Section" });
    expect(after[2]).toEqual({ type: "paragraph", text: "body" });
  });

  it("makes the title the only block on an empty doc (no reference block needed)", () => {
    // The pre-0038 live-editor path threw here (BlockNote insertion
    // needed a reference block). The owned write path just writes the
    // post-state — an empty doc gains exactly the title block.
    const ydoc = new Y.Doc();
    setDocTitle(ydoc, "From Nothing");

    const after = summarise(readBlocks(ydoc));
    expect(after).toEqual([{ type: "heading", level: 1, text: "From Nothing" }]);
  });
});
