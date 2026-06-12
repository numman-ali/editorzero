import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { docQueryKey } from "../lib/doc-editor";
import { DELETE_FAILED_MESSAGE, DOC_LIST_QUERY_KEY, deleteDoc } from "../lib/docs";

import "./inline-form.css";

/**
 * The `doc.delete × Web UI` cell: the editor toolbar's "Trash" control,
 * morphing in place into an inline confirm (the disclosure pattern the
 * new-doc/rename forms set). Soft-delete is recoverable BY DESIGN
 * (invariant 6 — `doc.restore` exists on the API/CLI/MCP surfaces);
 * the confirm step is there because the browser Trash screen is a
 * later cell (blocked on a trash-listing capability that doesn't exist
 * yet), so this surface can't undo its own action until that lands.
 *
 * No dirty-canvas gate, deliberately: trashing the doc discards
 * unsaved canvas edits along with everything else — that is the point
 * of the action, and the confirm step is the guard.
 *
 * On success: drop the doc's `doc.get` cache (the next fetch would
 * 404), invalidate `doc.list`, and navigate home.
 *
 * Coverage: orchestration-only — the wire call lives unit-tested in
 * `lib/docs.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/editor.spec.ts`).
 */

type TrashState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "failed" };

export function TrashDoc({ docId, disabled }: { docId: string; disabled: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TrashState>({ kind: "idle" });

  async function handleConfirm(): Promise<void> {
    if (state.kind === "deleting") return;
    setState({ kind: "deleting" });
    try {
      await deleteDoc(docId);
      queryClient.removeQueries({ queryKey: docQueryKey(docId) });
      await queryClient.invalidateQueries({ queryKey: DOC_LIST_QUERY_KEY });
      await navigate({ to: "/" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm doc-editor-danger"
        onClick={() => setState({ kind: "confirming" })}
        disabled={disabled}
      >
        Trash
      </button>
    );
  }

  const deleting = state.kind === "deleting";
  return (
    <span className="inlineform">
      <span className="doc-editor-status">Move this doc to trash?</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm doc-editor-danger"
        onClick={() => void handleConfirm()}
        disabled={deleting}
      >
        {deleting ? "Trashing…" : "Move to trash"}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setState({ kind: "idle" })}
        disabled={deleting}
      >
        Cancel
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          {DELETE_FAILED_MESSAGE}
        </span>
      ) : null}
    </span>
  );
}
