import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  type CreateFailure,
  classifyCreateError,
  createDoc,
  createFailureMessage,
  DOC_LIST_QUERY_KEY,
} from "../lib/docs";

import "./inline-form.css";

/**
 * The `doc.create × Web UI` cell: the docs panel header's "+ New doc"
 * affordance (the mock's `btn--ultra` bar button, 03-documents). The
 * button morphs in place into an inline title form — a title is
 * REQUIRED, not cosmetic: `doc.create` derives the slug from it and
 * refuses a sibling collision with a 409, so a fixed default title
 * ("Untitled") would hard-fail on the second click; there is no
 * doc.rename cell yet to fix one up afterwards.
 *
 * On success: invalidate `doc.list`, then navigate into the new doc's
 * editor (`/doc/$docId` — the seeded title block is what the user sees
 * first). On 409 the alert says to pick a different title (retrying
 * the same one can never succeed); other failures get the generic
 * retry arm. The bare cell creates at the workspace root — placing
 * into a collection needs a picker, a later increment.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/docs.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/docs.spec.ts`).
 */

type CreateState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "failed"; failure: CreateFailure };

export function NewDoc() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [state, setState] = useState<CreateState>({ kind: "idle" });

  // The trigger unmounts when the form replaces it, so focus management
  // IS the disclosure announcement: the title input takes focus on open.
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
      const created = await createDoc(trimmed);
      await queryClient.invalidateQueries({ queryKey: DOC_LIST_QUERY_KEY });
      await navigate({ to: "/doc/$docId", params: { docId: created.doc_id } });
    } catch (error) {
      setState({ kind: "failed", failure: classifyCreateError(error) });
    }
  }

  function handleCancel(): void {
    setOpen(false);
    setTitle("");
    setState({ kind: "idle" });
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--ultra btn--sm" onClick={() => setOpen(true)}>
        + New doc
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
        aria-label="Doc title"
        placeholder="Doc title"
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
          {createFailureMessage(state.failure)}
        </span>
      ) : null}
    </form>
  );
}
