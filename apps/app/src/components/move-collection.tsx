import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  COLLECTION_LIST_QUERY_KEY,
  type CollectionMoveFailure,
  type CollectionMovePolicy,
  type CollectionSummary,
  classifyCollectionMoveError,
  collectionDescendantIds,
  collectionListQueryOptions,
  collectionMoveFailureMessage,
  destinationBinding,
  moveCollection,
  parseMoveDestination,
  SPACE_DESTINATION_PREFIX,
} from "../lib/collections";
import { DOC_LIST_QUERY_KEY, MOVE_POLICIES } from "../lib/docs";
import { spaceListQueryOptions } from "../lib/spaces";

import "./inline-form.css";

/**
 * The `collection.move × Web UI` cell: the detail header's Move
 * disclosure — the MoveDoc recipe over a richer destination space. The
 * select offers the workspace root, every space's root, and every live
 * collection EXCEPT this collection's own subtree: `collection.move`
 * refuses cycles, and excluding those options realizes the rail in
 * chrome by construction (the unreachable 400 falls to the generic
 * arm; the server stays authoritative).
 *
 * The SHARING select appears exactly when the destination's bucket
 * differs from this collection's own binding (`destinationBinding` vs
 * `space_id` — ADR 0040 §7's two-pole rail over the whole subtree),
 * submit disabled until a pole is chosen. Same-destination is a no-op
 * close. Success invalidates `collection.list` (tree + facts) AND
 * `doc.list` (a crossing re-shapes subtree access).
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/collections.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/collections.spec.ts`).
 */

type MoveState =
  | { kind: "idle" }
  | { kind: "moving" }
  | { kind: "failed"; failure: CollectionMoveFailure };

/** The select's value for the current placement (prefill): see parseMoveDestination's encoding. */
function placementValue(collection: CollectionSummary): string {
  if (collection.parent_id !== null) return collection.parent_id;
  if (collection.space_id !== null) return `${SPACE_DESTINATION_PREFIX}${collection.space_id}`;
  return "";
}

export function MoveCollection({ collection }: { collection: CollectionSummary }) {
  const queryClient = useQueryClient();
  const { data: collectionData } = useQuery(collectionListQueryOptions());
  const { data: spaceData } = useQuery(spaceListQueryOptions());
  const selectRef = useRef<HTMLSelectElement>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [policy, setPolicy] = useState("");
  const [state, setState] = useState<MoveState>({ kind: "idle" });

  useEffect(() => {
    if (open) {
      selectRef.current?.focus();
    }
  }, [open]);

  const collections = collectionData?.collections ?? [];
  const spaces = spaceData?.spaces ?? [];
  const subtree = collectionDescendantIds(collection.id, collections);
  const destinations = collections.filter((c) => !subtree.has(c.id));
  const destination = parseMoveDestination(target);
  const crossing = destinationBinding(destination, collections) !== collection.space_id;
  const chosenPolicy = MOVE_POLICIES.find((p) => p.value === policy)?.value;

  function openForm(): void {
    setTarget(placementValue(collection));
    setPolicy("");
    setState({ kind: "idle" });
    setOpen(true);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind === "moving") return;
    if (target === placementValue(collection)) {
      setOpen(false);
      return;
    }
    const aclPolicy: CollectionMovePolicy = crossing ? chosenPolicy : undefined;
    if (crossing && aclPolicy === undefined) return; // submit is disabled; belt-and-braces
    setState({ kind: "moving" });
    try {
      await moveCollection(collection.id, destination, aclPolicy);
      await queryClient.invalidateQueries({ queryKey: COLLECTION_LIST_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: DOC_LIST_QUERY_KEY });
      setOpen(false);
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "failed", failure: classifyCollectionMoveError(error) });
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
        <option value="">Workspace root</option>
        {spaces.map((s) => (
          <option key={s.space_id} value={`${SPACE_DESTINATION_PREFIX}${s.space_id}`}>
            Space: {s.name}
          </option>
        ))}
        {destinations.map((c) => (
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
        {moving ? "Moving…" : "Move collection"}
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
          {collectionMoveFailureMessage(state.failure)}
        </span>
      ) : null}
    </form>
  );
}
