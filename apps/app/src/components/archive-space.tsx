import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  archiveSpace,
  classifySpaceArchiveError,
  SPACE_LIST_QUERY_KEY,
  type SpaceArchiveFailure,
  spaceArchiveFailureMessage,
  spaceQueryKey,
} from "../lib/spaces";

import "./inline-form.css";

/**
 * The `space.archive × Web UI` cell: the detail screen's danger action
 * (the trash-doc morph-confirm recipe). The confirm step is the guard
 * because the browser can't undo its own action yet: the soft-delete
 * is recoverable BY DESIGN (invariant 6 — `space.restore` revives row
 * + ACL 1:1), but no archived-spaces listing capability exists (the
 * doc-trash gap class), so restore is reachable via API/CLI/MCP only.
 *
 * The capability refuses while live collections, docs, or members
 * remain (no cascade — the caller empties the space first); that 409
 * gets its own actionable arm. Success: drop this space's `space.get`
 * cache, invalidate the list, navigate back to the grid.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/spaces.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/spaces.spec.ts`).
 */

type ArchiveState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "archiving" }
  | { kind: "failed"; failure: SpaceArchiveFailure };

export function ArchiveSpace({ spaceId }: { spaceId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ArchiveState>({ kind: "idle" });

  async function handleConfirm(): Promise<void> {
    if (state.kind === "archiving") return;
    setState({ kind: "archiving" });
    try {
      await archiveSpace(spaceId);
      queryClient.removeQueries({ queryKey: spaceQueryKey(spaceId) });
      await queryClient.invalidateQueries({ queryKey: SPACE_LIST_QUERY_KEY });
      await navigate({ to: "/space" });
    } catch (error) {
      setState({ kind: "failed", failure: classifySpaceArchiveError(error) });
    }
  }

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm inlineform-danger"
        onClick={() => setState({ kind: "confirming" })}
      >
        Archive
      </button>
    );
  }

  const archiving = state.kind === "archiving";
  return (
    <span className="inlineform">
      <span className="inlineform-status">Archive this Space?</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm inlineform-danger"
        onClick={() => void handleConfirm()}
        disabled={archiving}
      >
        {archiving ? "Archiving…" : "Archive Space"}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setState({ kind: "idle" })}
        disabled={archiving}
      >
        Cancel
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          {spaceArchiveFailureMessage(state.failure)}
        </span>
      ) : null}
    </span>
  );
}
