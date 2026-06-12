import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  COLLECTION_LIST_QUERY_KEY,
  type CollectionDeleteFailure,
  classifyCollectionDeleteError,
  collectionDeleteFailureMessage,
  deleteCollection,
} from "../lib/collections";

import "./inline-form.css";

/**
 * The `collection.delete × Web UI` cell: the detail screen's danger
 * action (the trash-doc / archive-space morph-confirm recipe; "Trash"
 * is the soft-delete vocabulary — invariant 6, `collection.restore`
 * revives 1:1, though restore stays API/CLI/MCP-only until a
 * trash-listing capability exists). The capability refuses while live
 * sub-collections or docs remain (no cascade); that 409 gets its own
 * actionable arm — counts never cross the wire.
 *
 * Success navigates home FIRST, then invalidates the list: the detail
 * screen reads the same `collection.list` cache, so invalidating while
 * still mounted would flash the just-trashed screen into its notFound
 * residual before the navigation lands.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/collections.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/collections.spec.ts`).
 */

type DeleteState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "deleting" }
  | { kind: "failed"; failure: CollectionDeleteFailure };

export function DeleteCollection({ collectionId }: { collectionId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<DeleteState>({ kind: "idle" });

  async function handleConfirm(): Promise<void> {
    if (state.kind === "deleting") return;
    setState({ kind: "deleting" });
    try {
      await deleteCollection(collectionId);
      await navigate({ to: "/" });
      await queryClient.invalidateQueries({ queryKey: COLLECTION_LIST_QUERY_KEY });
    } catch (error) {
      setState({ kind: "failed", failure: classifyCollectionDeleteError(error) });
    }
  }

  if (state.kind === "idle") {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm inlineform-danger"
        onClick={() => setState({ kind: "confirming" })}
      >
        Trash
      </button>
    );
  }

  const deleting = state.kind === "deleting";
  return (
    <span className="inlineform">
      <span className="inlineform-status">Trash this collection?</span>
      <button
        type="button"
        className="btn btn--ghost btn--sm inlineform-danger"
        onClick={() => void handleConfirm()}
        disabled={deleting}
      >
        {deleting ? "Trashing…" : "Trash collection"}
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
          {collectionDeleteFailureMessage(state.failure)}
        </span>
      ) : null}
    </span>
  );
}
