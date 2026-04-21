// @vitest-environment happy-dom
/// <reference lib="dom" />

/**
 * `setDocTitle` — unit test covers the three title-slot rule branches.
 *
 * Runs in plain Y.Doc land (no HocuspocusSync, no SQL). The integration
 * smoke (`blocknote.integration.test.ts` `editor.transact(updateBlock)`
 * case) covers the durability path end-to-end; this file exercises the
 * rule itself — block 0 is heading-1 → update in place; block 0 is a
 * paragraph → insert heading-1 at 0; block 0 is heading-2 → insert
 * heading-1 at 0.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { type LooseBlock, type LoosePartialBlock, readBlocks, seedBlocks } from "./blocks";
import { setDocTitle } from "./set-title";

function summarise(blocks: readonly LooseBlock[]): Array<{
  type: string;
  level?: number;
  text: string;
}> {
  return blocks.map((b) => {
    const parts = Array.isArray(b.content) ? (b.content as ReadonlyArray<{ text?: unknown }>) : [];
    const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    const level = (b.props as { level?: number }).level;
    return level !== undefined ? { type: b.type, level, text } : { type: b.type, text };
  });
}

describe("setDocTitle", () => {
  it("updates an existing heading-1 at index 0 in place (preserves block identity)", async () => {
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      {
        type: "heading",
        props: { level: 1 },
        content: "Old Title",
      } as unknown as LoosePartialBlock,
      { type: "paragraph", content: "body" } as LoosePartialBlock,
    ]);

    // Capture pre-rename block IDs. Identity-stable rename lets
    // downstream refs (audit seed_blocks, mentions) survive — a
    // regression that silently re-inserted block 0 would bump its id
    // and this assertion would catch it.
    const originalIds = readBlocks(ydoc).map((b) => b.id);

    await setDocTitle(ydoc, "New Title");

    const after = summarise(readBlocks(ydoc));
    // Heading stays at index 0 with updated text + level-1 untouched.
    expect(after[0]).toEqual({ type: "heading", level: 1, text: "New Title" });
    // Body paragraph survives.
    expect(after[1]).toEqual({ type: "paragraph", text: "body" });

    const afterIds = readBlocks(ydoc).map((b) => b.id);
    expect(afterIds[0]).toBe(originalIds[0]);
    expect(afterIds[1]).toBe(originalIds[1]);
  });

  it("inserts a heading-1 at index 0 when block 0 is a paragraph (non-title slot)", async () => {
    // Shape a v1 `doc.create` never produces, but a direct fragment
    // mutation (agent-crafted Y.Doc, legacy import) could. The rule:
    // recover the canonical layout by inserting heading-1 before the
    // existing block 0.
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      { type: "paragraph", content: "body first" } as LoosePartialBlock,
      { type: "paragraph", content: "body second" } as LoosePartialBlock,
    ]);

    await setDocTitle(ydoc, "Recovered Title");

    const after = summarise(readBlocks(ydoc));
    expect(after[0]).toEqual({ type: "heading", level: 1, text: "Recovered Title" });
    expect(after[1]).toEqual({ type: "paragraph", text: "body first" });
    expect(after[2]).toEqual({ type: "paragraph", text: "body second" });
  });

  it("inserts a heading-1 at index 0 when block 0 is a heading with level !== 1", async () => {
    // Heading present but wrong level — title convention is
    // specifically `level === 1`, so a level-2 block at index 0 does
    // not count as the title slot.
    const ydoc = new Y.Doc();
    seedBlocks(ydoc, [
      {
        type: "heading",
        props: { level: 2 },
        content: "Section",
      } as unknown as LoosePartialBlock,
      { type: "paragraph", content: "body" } as LoosePartialBlock,
    ]);

    await setDocTitle(ydoc, "Actual Title");

    const after = summarise(readBlocks(ydoc));
    expect(after[0]).toEqual({ type: "heading", level: 1, text: "Actual Title" });
    // The level-2 heading survives, demoted one slot — no silent
    // coercion of its level.
    expect(after[1]).toEqual({ type: "heading", level: 2, text: "Section" });
    expect(after[2]).toEqual({ type: "paragraph", text: "body" });
  });
});
