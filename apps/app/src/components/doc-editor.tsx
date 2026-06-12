import { type Block, blocksToPmDoc, editorExtensions, pmDocToBlocks } from "@editorzero/blocks";
import { useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import { useRef, useState } from "react";

import {
  buildSaveOps,
  classifySaveError,
  docQueryOptions,
  type SaveFailure,
  saveDoc,
  saveFailureMessage,
} from "../lib/doc-editor";
import { DOC_LIST_QUERY_KEY } from "../lib/docs";
import { RenameDoc } from "./rename-doc";
import { TrashDoc } from "./trash-doc";

import "./doc-editor.css";

/**
 * The HTTP-first doc editor (ADR 0038): a Tiptap editor over the SAME
 * owned extensions the server schema compiles from, loaded once from
 * `doc.get` and persisted by explicit Save as a `doc.update` ops batch
 * (diff + per-block hash preconditions — see `lib/doc-editor.ts`).
 * No WebSocket, no live CRDT binding — that's the collab slice; this
 * is the parity-cell editor every surface can already reason about.
 *
 * After a successful save the editor re-bases onto the server's
 * post-state (`doc.get` refetch + `setContent`), so server-minted ids
 * replace the `""` sentinels and the next diff is computed against
 * what actually persisted. On a 409 the v1 policy is reload-and-
 * discard, stated in the alert (the base is stale; merging is the
 * track-changes slice's territory).
 *
 * The toolbar also hosts the `doc.rename` cell (`RenameDoc`) — title
 * changes are a SEPARATE capability from content ops (title-slot rule:
 * row title + slug + the canvas heading move together in one audited
 * mutation), gated on a clean canvas so its re-base never discards
 * unsaved edits.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/doc-editor.ts`; this file is in the e2e-covered set, proven by
 * the marked Playwright spec (`packages/e2e/test/editor.spec.ts`).
 */

type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; failure: SaveFailure };

export function DocEditor({
  docId,
  docTitle,
  initialBlocks,
}: {
  docId: string;
  docTitle: string;
  initialBlocks: readonly Block[];
}) {
  const queryClient = useQueryClient();
  const baseRef = useRef(initialBlocks);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

  const editor = useEditor({
    extensions: editorExtensions(),
    content: blocksToPmDoc(baseRef.current),
    immediatelyRender: true,
    editorProps: {
      attributes: {
        "aria-label": "Doc content",
        class: "edcanvas doc-editor-surface",
      },
    },
    onUpdate: () => {
      // setContent after a save also lands here — don't let the
      // re-base transaction downgrade an in-flight save to "dirty".
      setSaveState((state) => (state.kind === "saving" ? state : { kind: "dirty" }));
    },
  });

  async function rebaseFromServer(): Promise<void> {
    // `staleTime: 0` forces a real refetch: under the app default (30s,
    // query-client.ts) `fetchQuery` would serve the route loader's
    // cached snapshot — re-basing onto PRE-save blocks, wiping the
    // just-typed content from the canvas and desyncing `baseRef` from
    // what the server now holds (the next diff's hash preconditions
    // would 409 against nothing).
    const fresh = await queryClient.fetchQuery({ ...docQueryOptions(docId), staleTime: 0 });
    baseRef.current = fresh.blocks;
    editor.commands.setContent(blocksToPmDoc(fresh.blocks));
  }

  async function handleSave(): Promise<void> {
    if (saveState.kind === "saving") return;
    setSaveState({ kind: "saving" });
    try {
      const current = pmDocToBlocks(editor.getJSON());
      const ops = await buildSaveOps(baseRef.current, current);
      if (ops.length > 0) {
        await saveDoc(docId, ops);
        await rebaseFromServer();
        await queryClient.invalidateQueries({ queryKey: DOC_LIST_QUERY_KEY });
      }
      setSaveState({ kind: "saved" });
    } catch (error) {
      setSaveState({ kind: "failed", failure: classifySaveError(error) });
    }
  }

  // Shared by the 409 Reload arm and the post-rename refresh: re-base,
  // then settle to idle (`setContent` fires onUpdate, which would
  // otherwise mark the just-loaded server state "dirty").
  async function handleReload(): Promise<void> {
    await rebaseFromServer();
    setSaveState({ kind: "idle" });
  }

  const failure = saveState.kind === "failed" ? saveState.failure : null;

  return (
    <div className="doc-editor">
      <div className="doc-editor-toolbar">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => void handleSave()}
          disabled={saveState.kind === "saving"}
        >
          {saveState.kind === "saving" ? "Saving…" : "Save"}
        </button>
        <span className="doc-editor-status" role="status">
          {saveState.kind === "saved"
            ? "Saved"
            : saveState.kind === "dirty"
              ? "Unsaved changes"
              : ""}
        </span>
        <span className="doc-editor-spacer" />
        {/* Dirty-canvas gate: the post-rename re-base replaces canvas
            content wholesale, which is only safe while canvas == server. */}
        <RenameDoc
          docId={docId}
          currentTitle={docTitle}
          disabled={saveState.kind === "dirty" || saveState.kind === "saving"}
          onRenamed={handleReload}
        />
        {/* No dirty gate — trashing discards unsaved edits by intent;
            the confirm step is the guard. Disabled mid-save only so an
            in-flight ops batch can't race the soft-delete. */}
        <TrashDoc docId={docId} disabled={saveState.kind === "saving"} />
      </div>
      {failure !== null ? (
        <div className="doc-editor-alert" role="alert">
          <span>{saveFailureMessage(failure)}</span>
          {failure === "conflict" ? (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void handleReload()}
            >
              Reload
            </button>
          ) : null}
        </div>
      ) : null}
      <EditorContent editor={editor} />
    </div>
  );
}
