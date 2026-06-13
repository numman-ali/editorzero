import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { AGENT_LIST_QUERY_KEY, createAgent } from "../lib/agents";

import "./inline-form.css";

/**
 * The `agent.create × Web UI` cell: the Agents panel header's "+ New
 * agent" affordance (the new-doc/new-space morph recipe — the trigger
 * unmounts, the inline form takes focus). One wire field, the display
 * name; authority grounds in the creating owner (Decision 2). Names are
 * not unique, so there is no collision arm — any failure is a generic
 * retry line.
 *
 * On success: invalidate `agent.list`, then navigate into the new
 * agent's detail screen (`/agent/$agentId` — the create→detail pattern),
 * where tokens are minted.
 *
 * Coverage: orchestration-only — the data layer lives unit-tested in
 * `lib/agents.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/credentials.spec.ts`).
 */

type CreateState = { kind: "idle" } | { kind: "creating" } | { kind: "failed" };

export function NewAgent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [state, setState] = useState<CreateState>({ kind: "idle" });

  // The trigger unmounts when the form replaces it, so focus management
  // IS the disclosure announcement: the name input takes focus on open.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || state.kind === "creating") return;
    setState({ kind: "creating" });
    try {
      const created = await createAgent(trimmed);
      await queryClient.invalidateQueries({ queryKey: AGENT_LIST_QUERY_KEY });
      await navigate({ to: "/agent/$agentId", params: { agentId: created.agent_id } });
    } catch {
      setState({ kind: "failed" });
    }
  }

  function handleCancel(): void {
    setOpen(false);
    setName("");
    setState({ kind: "idle" });
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--ultra btn--sm" onClick={() => setOpen(true)}>
        + New agent
      </button>
    );
  }

  const creating = state.kind === "creating";
  return (
    <form className="inlineform" onSubmit={(event) => void handleSubmit(event)}>
      <input
        ref={inputRef}
        className="inlineform-input"
        type="text"
        aria-label="Agent name"
        placeholder="Agent name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={creating}
      />
      <button
        type="submit"
        className="btn btn--ultra btn--sm"
        disabled={creating || name.trim() === ""}
      >
        {creating ? "Creating…" : "Create"}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={handleCancel}
        disabled={creating}
      >
        Cancel
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          Create failed. Try again.
        </span>
      ) : null}
    </form>
  );
}
