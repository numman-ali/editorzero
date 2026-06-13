import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { AGENT_LIST_QUERY_KEY, type AgentDetail, agentQueryKey, updateAgent } from "../lib/agents";
import { formatUpdated } from "../lib/docs";

import "./inline-form.css";

/**
 * The `agent.update × Web UI` cell: the agent detail body — the `.kv`
 * fact rows with an "Edit agent" disclosure that swaps them for the
 * rename form (the morph recipe; the facts ARE the closed state).
 *
 * Name is the agent's ONLY mutable field — no slug, type, or baseline
 * the way a space has. The agent id, owner, and created-by are raw ids;
 * the id is the agent's own addressable handle (mint tokens against it),
 * so it is shown, while `owner_user_id` / `created_by` stay off-screen —
 * they resolve to a human only through the member roster, the same gap
 * the space screen leaves (rendering UUIDs would be noise, not honesty).
 *
 * The form sends the new name only when it actually changed (an
 * unchanged form closes without a wire call — the rename-doc no-op
 * precedent). Success invalidates `agent.get` (this screen re-renders
 * from the fresh row) + `agent.list` (the roster card).
 *
 * `children` render into the closed state's button row (the agent's
 * other verb — today the `agent.revoke` confirm); the open form hides
 * them, one mutation at a time.
 *
 * `readOnly` is the revoked state: the facts still render (the row is
 * terminal-but-visible), but the rename disclosure + `children` give way
 * to a muted note — a revoked agent takes no further mutation, so
 * offering controls the capability would refuse is dishonest chrome.
 *
 * Coverage: orchestration-only — the data layer lives unit-tested in
 * `lib/agents.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/credentials.spec.ts`).
 */

type UpdateState = { kind: "idle" } | { kind: "saving" } | { kind: "failed" };

export function EditAgent({
  agent,
  children,
  readOnly = false,
}: {
  agent: AgentDetail;
  children?: ReactNode;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(agent.name);
  const [state, setState] = useState<UpdateState>({ kind: "idle" });

  // The trigger unmounts when the form replaces the facts, so focus
  // management IS the disclosure announcement.
  useEffect(() => {
    if (open) {
      nameRef.current?.focus();
    }
  }, [open]);

  function openForm(): void {
    // Prefill from the CURRENT row each open — it may have been refreshed
    // since the last edit.
    setName(agent.name);
    setState({ kind: "idle" });
    setOpen(true);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind === "saving") return;
    const trimmed = name.trim();
    // Unchanged or empty ⇒ close without a wire call (the capability would
    // audit a no-op transition otherwise).
    if (trimmed === "" || trimmed === agent.name) {
      setOpen(false);
      return;
    }
    setState({ kind: "saving" });
    try {
      await updateAgent(agent.agent_id, trimmed);
      await queryClient.invalidateQueries({ queryKey: agentQueryKey(agent.agent_id) });
      await queryClient.invalidateQueries({ queryKey: AGENT_LIST_QUERY_KEY });
      setOpen(false);
      setState({ kind: "idle" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  if (!open) {
    return (
      <div style={{ padding: "15px" }}>
        <div className="kv">
          <span className="k">agent id</span>
          <span className="v mono">{agent.agent_id}</span>
        </div>
        <div className="kv">
          <span className="k">created</span>
          <span className="v mono">{formatUpdated(agent.created_at)}</span>
        </div>
        <div className="kv">
          <span className="k">updated</span>
          <span className="v mono">{formatUpdated(agent.updated_at)}</span>
        </div>
        <div className="kv">
          <span className="k" />
          {readOnly ? (
            <span className="inlineform-status">Revoked — no further changes.</span>
          ) : (
            <span className="inlineform">
              <button type="button" className="btn btn--ghost btn--sm" onClick={openForm}>
                Edit agent
              </button>
              {children}
            </span>
          )}
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
          aria-label="Agent name"
          placeholder="Agent name"
          value={name}
          onChange={(event) => setName(event.target.value)}
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
            Rename failed. Try again.
          </span>
        ) : null}
      </form>
    </div>
  );
}
