import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AGENT_LIST_QUERY_KEY, agentQueryKey, revokeAgent } from "../lib/agents";

import "./inline-form.css";

/**
 * The `agent.revoke × Web UI` cell: the detail screen's danger action
 * (the archive-space morph-confirm recipe). The confirm step is the
 * guard — revocation is TERMINAL (invariant 8; `revoked_at` never
 * resets) and cascades to every bearer token the agent holds, so there
 * is no undo to lean on.
 *
 * Unlike a space archive, the agent does NOT vanish: it stays
 * terminal-but-visible (Decision 2), so success drops this agent's
 * `agent.get` cache, invalidates the roster, and navigates back to it —
 * where the agent now reads "Revoked".
 *
 * Coverage: orchestration-only — the data layer lives unit-tested in
 * `lib/agents.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/credentials.spec.ts`).
 */

type RevokeState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "revoking" }
  | { kind: "failed" };

export function RevokeAgent({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<RevokeState>({ kind: "idle" });

  async function handleConfirm(): Promise<void> {
    if (state.kind === "revoking") return;
    setState({ kind: "revoking" });
    try {
      await revokeAgent(agentId);
      queryClient.removeQueries({ queryKey: agentQueryKey(agentId) });
      await queryClient.invalidateQueries({ queryKey: AGENT_LIST_QUERY_KEY });
      await navigate({ to: "/agent" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm inlineform-danger"
        onClick={() => setState({ kind: "confirming" })}
      >
        Revoke
      </button>
    );
  }

  const revoking = state.kind === "revoking";
  return (
    <span className="inlineform">
      <span className="inlineform-status">Revoke this agent?</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm inlineform-danger"
        onClick={() => void handleConfirm()}
        disabled={revoking}
      >
        {revoking ? "Revoking…" : "Revoke agent"}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setState({ kind: "idle" })}
        disabled={revoking}
      >
        Cancel
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          Revoke failed. Try again.
        </span>
      ) : null}
    </span>
  );
}
