/// <reference lib="dom" />

/**
 * `setDocTitle` — enforce the doc-title slot rule on a Y.Doc through
 * the live-editor lifecycle (architecture.md §16.5, ADR 0018).
 *
 * **Title convention.** An editorzero doc's title is the heading block
 * with `level = 1` sitting at document index 0 (see `packages/blocks/
 * src/core/heading.ts` comment). `doc.create` seeds exactly this shape:
 * heading-1 at index 0 + a trailing empty paragraph.
 *
 * **The rule.** On a rename:
 *   - If `editor.document[0]` is a heading with `level === 1`: call
 *     `editor.updateBlock` in place. Cheap — one block mutation, and
 *     the block `id` stays stable so downstream references (e.g.,
 *     audit-recorded seed_blocks, embedded mentions) survive.
 *   - Otherwise (block 0 has a different type, or different level):
 *     `editor.insertBlocks` a fresh heading-1 at position 0 with
 *     `placement: "before"`. Existing blocks shift down by one. The
 *     alternative — coerce block 0's `type` / `props` — is not an API
 *     BlockNote offers; insertion is the only path to recover the
 *     canonical layout.
 *
 * **Why "index 0" and not "first heading-1 anywhere".** The looser rule
 * would let a rename mutate a heading-1 buried mid-doc, which is a
 * surprising action. The strict index-0 rule matches `doc.create`'s
 * seed, keeps the title deterministic, and makes "no title present"
 * recoverable in one call without a schema-repair capability.
 *
 * **Caller contract.** Must be called from inside `ctx.transact`
 * (invariant 7 — CRDT mutations go through the dispatcher's write-path
 * tx). The `ydoc` argument is the one `ctx.transact` passes into the
 * handler; `setDocTitle` binds a live BlockNoteEditor to that doc's
 * BlockNote fragment via `withLiveEditor` and issues the mutation
 * inside `editor.transact(...)` so the change commits as one
 * y-prosemirror step (matches the single-update-blob-per-tx shape).
 *
 * **Why `async`.** `withLiveEditor` is async (mount + dispose). The
 * title-mutation itself is synchronous inside the editor.transact
 * block, but the lifecycle around it is not.
 *
 * **Empty document is unreachable in production.** Once the live
 * editor mounts, its normalisation tail keeps at least one block
 * (empty paragraph) visible. `doc.create` further guarantees two
 * seed blocks. A defensive throw catches the "mount produced an empty
 * document.document" regression — not user-facing, surfaces as
 * HandlerError inside the write-path tx if it ever fires.
 */

import type * as Y from "yjs";

import type { LoosePartialBlock } from "./blocks";
import { withLiveEditor } from "./live-editor";

export async function setDocTitle(ydoc: Y.Doc, title: string): Promise<void> {
  await withLiveEditor(ydoc, (editor) => {
    editor.transact(() => {
      const block0 = editor.document[0];
      if (block0 === undefined) {
        throw new Error(
          "setDocTitle: live editor's document is empty after mount — " +
            "expected a normalisation-tail paragraph at minimum. Cannot insert " +
            "a title block without a reference.",
        );
      }
      const level = (block0.props as { level?: unknown }).level;
      const isTitleSlot = block0.type === "heading" && level === 1;
      if (isTitleSlot) {
        // In-place update keeps `block0.id` stable.
        editor.updateBlock(block0, {
          content: title,
        } as unknown as LoosePartialBlock);
        return;
      }
      // Non-title-slot block at index 0 — insert a fresh heading-1
      // before it. `insertBlocks([...], referenceBlock, "before")`
      // is BlockNote's position-0 insertion shape; the referenceBlock
      // itself is not modified.
      editor.insertBlocks(
        [
          {
            type: "heading",
            props: { level: 1 },
            content: title,
          } as unknown as LoosePartialBlock,
        ],
        block0,
        "before",
      );
    });
  });
}
