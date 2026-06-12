import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { formatUpdated } from "../lib/docs";
import {
  classifyWorkspaceUpdateError,
  diffWorkspacePatch,
  updateWorkspace,
  WORKSPACE_GET_QUERY_KEY,
  type WorkspaceGet,
  type WorkspaceUpdateFailure,
  workspaceUpdateFailureMessage,
} from "../lib/workspace";

import "./inline-form.css";

/**
 * The `workspace.update × Web UI` cell: the settings screen's body —
 * `.kv` fact rows with the Edit disclosure (the edit-space recipe).
 *
 * The form offers exactly the capability's v1 mutable subset: `name`
 * and `trash_retention_days` (the number input carries the ADR 0017
 * bounds as native min/max — the browser's constraint validation
 * blocks an out-of-range submit before the wire). NOT offered: `slug`
 * (immutable by the capability — bootstrap-derived; re-slugging would
 * orphan outbound links) and the free-form `settings` record (no UI
 * shape yet).
 *
 * Only changed fields travel (`diffWorkspacePatch`, unit-tested); an
 * unchanged form closes without a wire call. Success invalidates
 * `workspace.get` — the `_authed` layout reads that key REACTIVELY, so
 * the sidebar identity block re-renders in the same pass (the
 * cross-chrome effect the proving spec pins). 403 gets its own arm:
 * the caller's role, not a retry, is the blocker.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/workspace.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/workspace.spec.ts`).
 */

type UpdateState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "failed"; failure: WorkspaceUpdateFailure };

export function EditWorkspace({ workspace }: { workspace: WorkspaceGet }) {
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [retention, setRetention] = useState(String(workspace.trash_retention_days));
  const [state, setState] = useState<UpdateState>({ kind: "idle" });

  useEffect(() => {
    if (open) {
      nameRef.current?.focus();
    }
  }, [open]);

  function openForm(): void {
    setName(workspace.name);
    setRetention(String(workspace.trash_retention_days));
    setState({ kind: "idle" });
    setOpen(true);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind === "saving") return;
    const patch = diffWorkspacePatch(workspace, {
      name,
      trash_retention_days: Number.parseInt(retention, 10),
    });
    if (patch === null) {
      setOpen(false);
      return;
    }
    setState({ kind: "saving" });
    try {
      await updateWorkspace(patch);
      await queryClient.invalidateQueries({ queryKey: WORKSPACE_GET_QUERY_KEY });
      setOpen(false);
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "failed", failure: classifyWorkspaceUpdateError(error) });
    }
  }

  if (!open) {
    return (
      <div style={{ padding: "15px" }}>
        <div className="kv">
          <span className="k">trash retention</span>
          <span className="v mono">{workspace.trash_retention_days} days</span>
        </div>
        <div className="kv">
          <span className="k">created</span>
          <span className="v mono">{formatUpdated(workspace.created_at)}</span>
        </div>
        <div className="kv">
          <span className="k" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={openForm}>
            Edit workspace
          </button>
        </div>
      </div>
    );
  }

  const saving = state.kind === "saving";
  return (
    <div style={{ padding: "15px" }}>
      <form className="inlineform" onSubmit={(event) => void handleSubmit(event)}>
        <input
          ref={nameRef}
          className="inlineform-input"
          type="text"
          aria-label="Workspace name"
          placeholder="Workspace name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
        />
        <input
          className="inlineform-input"
          type="number"
          aria-label="Trash retention days"
          min={7}
          max={365}
          step={1}
          value={retention}
          onChange={(event) => setRetention(event.target.value)}
          disabled={saving}
        />
        <button
          type="submit"
          className="btn btn--ultra btn--sm"
          disabled={saving || name.trim() === ""}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setOpen(false)}
          disabled={saving}
        >
          Cancel
        </button>
        {state.kind === "failed" ? (
          <span className="inlineform-err" role="alert">
            {workspaceUpdateFailureMessage(state.failure)}
          </span>
        ) : null}
      </form>
    </div>
  );
}
