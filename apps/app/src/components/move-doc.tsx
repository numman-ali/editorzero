import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { collectionListQueryOptions, placementBinding } from "../lib/collections";
import { docQueryKey } from "../lib/doc-editor";
import {
  classifyMoveError,
  DOC_LIST_QUERY_KEY,
  MOVE_POLICIES,
  type MoveFailure,
  type MovePolicy,
  moveDoc,
  moveFailureMessage,
} from "../lib/docs";

import "./inline-form.css";

/**
 * The `doc.move × Web UI` cell: the doc header's Move disclosure. The
 * destination select offers the workspace root plus every live
 * collection (the layout-warmed `collection.list` cache); the SHARING
 * select appears exactly when the chosen move CROSSES placement
 * buckets (`placementBinding` on source vs target — ADR 0040 Step 8's
 * two-pole rail), and submit stays disabled until a pole is chosen —
 * the server's never-silent contract realized in chrome, by
 * construction instead of refused round-trips (the wire's
 * ValidationError envelope is code-generic, so a client that cannot
 * derive the bucket cannot know a policy is required until the 400).
 *
 * Same-bucket moves send no policy (the server refuses one); choosing
 * the current placement is a no-op that closes without a wire call.
 * Success invalidates `doc.get` (the header placement line) +
 * `doc.list`. No dirty-canvas gate: a move never touches content or
 * re-bases the editor (contrast rename).
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/docs.ts` + `lib/collections.ts`; proven by the marked
 * Playwright spec (`packages/e2e/test/editor.spec.ts`).
 */

type MoveState = { kind: "idle" } | { kind: "moving" } | { kind: "failed"; failure: MoveFailure };

/** The select's value for the workspace root (ids are UUIDs — no clash). */
const ROOT = "";

export function MoveDoc({
  docId,
  currentCollectionId,
}: {
  docId: string;
  currentCollectionId: string | null;
}) {
  const queryClient = useQueryClient();
  const { data } = useQuery(collectionListQueryOptions());
  const selectRef = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(ROOT);
  const [policy, setPolicy] = useState("");
  const [state, setState] = useState<MoveState>({ kind: "idle" });

  useEffect(() => {
    if (open) {
      selectRef.current?.focus();
    }
  }, [open]);

  const collections = data?.collections ?? [];
  const targetId = target === ROOT ? null : target;
  const crossing =
    placementBinding(currentCollectionId, collections) !== placementBinding(targetId, collections);
  const chosenPolicy = MOVE_POLICIES.find((p) => p.value === policy)?.value;

  function openForm(): void {
    setTarget(currentCollectionId ?? ROOT);
    setPolicy("");
    setState({ kind: "idle" });
    setOpen(true);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind === "moving") return;
    if (targetId === currentCollectionId) {
      setOpen(false);
      return;
    }
    const aclPolicy: MovePolicy | undefined = crossing ? chosenPolicy : undefined;
    if (crossing && aclPolicy === undefined) return; // submit is disabled; belt-and-braces
    setState({ kind: "moving" });
    try {
      await moveDoc(docId, targetId, aclPolicy);
      await queryClient.invalidateQueries({ queryKey: docQueryKey(docId) });
      await queryClient.invalidateQueries({ queryKey: DOC_LIST_QUERY_KEY });
      setOpen(false);
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "failed", failure: classifyMoveError(error) });
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost btn--sm" onClick={openForm}>
        Move
      </button>
    );
  }

  const moving = state.kind === "moving";
  return (
    <form className="inlineform" onSubmit={(event) => void handleSubmit(event)}>
      <select
        ref={selectRef}
        className="inlineform-select"
        aria-label="Destination"
        value={target}
        onChange={(event) => {
          setTarget(event.target.value);
          setPolicy(""); // a new destination is a new crossing question
        }}
        disabled={moving}
      >
        <option value={ROOT}>Workspace root</option>
        {collections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
      {crossing && (
        <select
          className="inlineform-select"
          aria-label="Sharing policy"
          value={policy}
          onChange={(event) => setPolicy(event.target.value)}
          disabled={moving}
        >
          <option value="" disabled>
            sharing…
          </option>
          {MOVE_POLICIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      )}
      <button
        type="submit"
        className="btn btn--ultra btn--sm"
        disabled={moving || (crossing && chosenPolicy === undefined)}
      >
        {moving ? "Moving…" : "Move doc"}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => setOpen(false)}
        disabled={moving}
      >
        Cancel
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          {moveFailureMessage(state.failure)}
        </span>
      ) : null}
    </form>
  );
}
