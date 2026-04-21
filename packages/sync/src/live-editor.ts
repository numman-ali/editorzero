/// <reference lib="dom" />

/**
 * `withLiveEditor` — mount a headless `BlockNoteEditor` bound to a
 * Y.Doc's BlockNote fragment, hand it to the callback, and tear down
 * on exit (architecture.md §6.5, ADR 0018 § Empirical verification).
 *
 * The live editor is the primitive content-mutation capabilities use
 * for `updateBlock` / `removeBlocks` / post-create `insertBlocks` — any
 * write that needs ProseMirror's `view.dispatch` path to flush the
 * y-prosemirror collab plugin's writes back into the `Y.XmlFragment`.
 * `seedBlocks` / `readBlocks` (see `./blocks`) continue to own the
 * pure-converter path — first-time seeds + read projections don't
 * need a view.
 *
 * **DOM requirement.** The collab plugin flushes through a mounted
 * `EditorView`, which requires `document.createElement`. Callers must
 * ensure a DOM is globally available:
 *   - Tests: `@vitest-environment happy-dom` at the file level.
 *   - API server runtime: happy-dom globals registered at
 *     `createApiApp` composition boot (see `@editorzero/api-server`).
 *
 * A missing-DOM failure surfaces at `document.createElement` here — not
 * deep inside BlockNote's collab plugin — so the error is close to its
 * cause.
 *
 * **Lifecycle.** Mount creates a detached `<div>`, calls
 * `editor.mount(host)`. Dispose (in `finally`) calls `editor.unmount()`
 * then `editor._tiptapEditor.destroy()`; `destroy()` releases
 * ProseMirror state + the y-prosemirror plugin's listeners so the
 * fragment's listener count stays bounded under repeated handler
 * invocations (otherwise each call would leak a listener).
 *
 * **Handler contract.** The callback receives the editor; any mutation
 * MUST wrap in `editor.transact(() => ...)` so the fragment change
 * commits as one y-prosemirror step. Matches the BlockNote smoke
 * (`packages/sync/src/blocknote.integration.test.ts`) and keeps the
 * write-path tx's `doc_updates` row to a single update blob per handler
 * invocation.
 *
 * **Returns** the callback's value. A throw from `fn` propagates after
 * dispose runs; the SQL-side rollback + `BoundSyncService.rollback`
 * eviction are the caller's job (`runInWriteTx` in
 * `@editorzero/api-server`).
 */

import {
  BlockNoteEditor,
  type BlockSchema,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import type * as Y from "yjs";

import { BLOCKNOTE_FRAGMENT } from "./blocks";

/**
 * Loose BlockNote editor type — same widening `blocks.ts` uses so the
 * default-schema concrete types line up with our `BlockSchema` /
 * `InlineContentSchema` / `StyleSchema` generics.
 */
export type LiveEditor = BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>;

const SERVER_USER = { name: "ez server", color: "#000000" } as const;

export async function withLiveEditor<R>(
  ydoc: Y.Doc,
  fn: (editor: LiveEditor) => Promise<R> | R,
): Promise<R> {
  const fragment = ydoc.getXmlFragment(BLOCKNOTE_FRAGMENT);
  const editor = BlockNoteEditor.create({
    collaboration: {
      fragment,
      // Collab-plugin `user` is presence metadata only — never lands
      // in the audit row (principal attribution goes through
      // `doc_updates.principal_id` in the write-path tx). A fixed
      // server identity keeps the live-editor side deterministic; a
      // future presence slice can plumb the principal through here.
      user: SERVER_USER,
    },
  }) as unknown as LiveEditor;
  const host = document.createElement("div");
  editor.mount(host);
  try {
    return await fn(editor);
  } finally {
    // Order matters: unmount detaches the EditorView first, then
    // destroy releases ProseMirror + y-prosemirror plugin state.
    // Reversing would leave an orphan view briefly holding listeners
    // against an already-destroyed tiptap editor.
    editor.unmount();
    editor._tiptapEditor.destroy();
  }
}
