import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import {
  COLLECTION_LIST_QUERY_KEY,
  type CollectionSummary,
  type CollectionUpdateFailure,
  classifyCollectionUpdateError,
  collectionUpdateFailureMessage,
  updateCollection,
} from "../lib/collections";

import "./inline-form.css";

/**
 * The `collection.update × Web UI` cell: the detail screen's Edit
 * disclosure. One field — `title` is the capability's whole v1 mutable
 * surface (`slug` re-derives in the handler; placement belongs to
 * `collection.move`, a later cell). An unchanged title closes without a
 * wire call; success invalidates `collection.list` — the detail screen
 * AND the sidebar tree both read that cache, so the rename lands across
 * the chrome in one pass. The 409 sibling-slug arm gets the same
 * pick-another-title message as create (retrying can never succeed).
 *
 * `children` (the Trash control) render in the closed button row and
 * hide while the form is open — one mutation at a time (the EditSpace
 * precedent).
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/collections.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/collections.spec.ts`).
 */

type UpdateState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "failed"; failure: CollectionUpdateFailure };

export function EditCollection({
  collection,
  children,
}: {
  collection: CollectionSummary;
  children?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(collection.title);
  const [state, setState] = useState<UpdateState>({ kind: "idle" });

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  function openForm(): void {
    setTitle(collection.title);
    setState({ kind: "idle" });
    setOpen(true);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind === "saving") return;
    const trimmed = title.trim();
    if (trimmed === "" || trimmed === collection.title) {
      setOpen(false);
      return;
    }
    setState({ kind: "saving" });
    try {
      await updateCollection(collection.id, trimmed);
      await queryClient.invalidateQueries({ queryKey: COLLECTION_LIST_QUERY_KEY });
      setOpen(false);
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "failed", failure: classifyCollectionUpdateError(error) });
    }
  }

  if (!open) {
    return (
      <div className="kv">
        <span className="k" />
        <span className="inlineform">
          <button type="button" className="btn btn--ghost btn--sm" onClick={openForm}>
            Edit collection
          </button>
          {children}
        </span>
      </div>
    );
  }

  const saving = state.kind === "saving";
  return (
    <form className="inlineform" onSubmit={(event) => void handleSubmit(event)}>
      <input
        ref={inputRef}
        className="inlineform-input"
        type="text"
        aria-label="Collection title"
        placeholder="Collection title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={saving}
      />
      <button
        type="submit"
        className="btn btn--ultra btn--sm"
        disabled={saving || title.trim() === ""}
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
          {collectionUpdateFailureMessage(state.failure)}
        </span>
      ) : null}
    </form>
  );
}
