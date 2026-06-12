import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  COLLECTION_LIST_QUERY_KEY,
  type CollectionCreateFailure,
  classifyCollectionCreateError,
  collectionCreateFailureMessage,
  createCollection,
} from "../lib/collections";

import "./inline-form.css";

/**
 * The `collection.create × Web UI` cell: the sidebar Collections
 * section header plus its "+" disclosure (the new-doc morph recipe —
 * the trigger unmounts and the inline title form takes focus). The
 * component owns the WHOLE section header so the affordance exists
 * even on an empty workspace: with a create control, "no collections"
 * is a starting point, not a dead section — the tree `<nav>` below
 * stays honestly absent until rows exist.
 *
 * The bare cell creates at the workspace ROOT (`title` only — a
 * parent/space picker is a later increment with the tree screens). On
 * success: invalidate `collection.list` (the tree re-renders with the
 * new row — there is no collection screen to navigate to yet), close
 * the form. The 409 sibling-slug arm says to pick a different title;
 * everything else gets the generic retry line (vocabulary unit-tested
 * in `lib/collections.ts`).
 *
 * Renders in BOTH sidebar hosts (desktop aside + mobile drawer — the
 * shared `SideContent`); each instance carries its own disclosure
 * state, and only one host is on screen at a time.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/collections.ts`; this file is in the e2e-covered set, proven by
 * the marked Playwright spec (`packages/e2e/test/collections.spec.ts`).
 */

type CreateState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "failed"; failure: CollectionCreateFailure };

export function NewCollection() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [state, setState] = useState<CreateState>({ kind: "idle" });

  // The trigger unmounts when the form opens, so focus management IS
  // the disclosure announcement: the title input takes focus on open.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "" || state.kind === "creating") return;
    setState({ kind: "creating" });
    try {
      await createCollection(trimmed);
      await queryClient.invalidateQueries({ queryKey: COLLECTION_LIST_QUERY_KEY });
      setOpen(false);
      setTitle("");
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "failed", failure: classifyCollectionCreateError(error) });
    }
  }

  function handleCancel(): void {
    setOpen(false);
    setTitle("");
    setState({ kind: "idle" });
  }

  const creating = state.kind === "creating";
  return (
    <>
      <div
        className="nav-h kicker"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <span>Collections</span>
        {!open && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label="New collection"
            onClick={() => setOpen(true)}
          >
            +
          </button>
        )}
      </div>
      {open && (
        <div style={{ padding: "2px 18px 8px" }}>
          <form className="inlineform" onSubmit={(event) => void handleSubmit(event)}>
            <input
              ref={inputRef}
              className="inlineform-input"
              type="text"
              aria-label="Collection title"
              placeholder="Collection title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={creating}
            />
            <button
              type="submit"
              className="btn btn--ultra btn--sm"
              disabled={creating || title.trim() === ""}
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
                {collectionCreateFailureMessage(state.failure)}
              </span>
            ) : null}
          </form>
        </div>
      )}
    </>
  );
}
