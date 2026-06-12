/**
 * `setDocTitle` — enforce the doc-title slot rule on a Y.Doc
 * (architecture.md §16.5, ADR 0018).
 *
 * **Title convention.** An editorzero doc's title is the heading block
 * with `level = 1` sitting at document index 0 (see `packages/blocks/
 * src/core/heading.ts`). `doc.create` seeds exactly this shape:
 * heading-1 at index 0 + a trailing empty paragraph.
 *
 * **The rule.** On a rename:
 *   - If block 0 is a heading with `level === 1`: replace its content
 *     in place. Cheap — one block changes, and the block `id` stays
 *     stable so downstream references (audit-recorded seed_blocks,
 *     future embedded mentions) survive.
 *   - Otherwise (block 0 has a different type or level, or the doc is
 *     empty): insert a fresh heading-1 at position 0 with a newly
 *     minted id. Existing blocks shift down by one.
 *
 * **Why "index 0" and not "first heading-1 anywhere".** The looser rule
 * would let a rename mutate a heading-1 buried mid-doc, which is a
 * surprising action. The strict index-0 rule matches `doc.create`'s
 * seed, keeps the title deterministic, and makes "no title present"
 * recoverable in one call without a schema-repair capability.
 *
 * **Caller contract.** Must be called from inside `ctx.transact`
 * (invariant 7 — CRDT mutations go through the dispatcher's write-path
 * tx). Synchronous since ADR 0038: the owned read → modify →
 * `writeBlocks` path has no editor-mount lifecycle, and `writeBlocks`
 * commits as one Yjs transaction (the single-update-blob-per-tx
 * shape).
 */

import { type Block, normalizeContent } from "@editorzero/blocks";
import { generateBlockId } from "@editorzero/ids";
import type * as Y from "yjs";

import { readBlocks, writeBlocks } from "./blocks";

export function setDocTitle(ydoc: Y.Doc, title: string): void {
  const blocks = readBlocks(ydoc);
  const block0 = blocks[0];
  const content = normalizeContent(title);

  if (block0 !== undefined && block0.type === "heading" && block0.props["level"] === 1) {
    const retitled: Block = { ...block0, content };
    writeBlocks(ydoc, [retitled, ...blocks.slice(1)]);
    return;
  }

  const titleBlock: Block = {
    id: generateBlockId(),
    type: "heading",
    props: { level: 1 },
    content,
    children: [],
  };
  writeBlocks(ydoc, [titleBlock, ...blocks]);
}
