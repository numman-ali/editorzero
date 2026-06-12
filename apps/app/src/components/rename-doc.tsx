import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  classifyRenameError,
  DOC_LIST_QUERY_KEY,
  type RenameFailure,
  renameDoc,
  renameFailureMessage,
} from "../lib/docs";

import "./inline-form.css";

/**
 * The `doc.rename × Web UI` cell: the editor toolbar's "Rename" control,
 * morphing in place into an inline title form (the new-doc disclosure
 * pattern). Renaming is NOT the same as editing the canvas heading —
 * `doc.rename` is one audited mutation that updates `docs.title`,
 * re-derives the slug, and rewrites the Y.Doc title block; a canvas edit
 * is a content op that leaves the row title behind (the documented v1
 * seam this cell closes for browser users).
 *
 * The host gates `disabled` on a dirty canvas: the post-rename
 * `onRenamed` re-base replaces editor content wholesale, which is only
 * safe when canvas == server. Renaming to the unchanged title closes
 * the form without a wire call — the capability would refuse the
 * self-collision, and an empty mutation deserves no audit row anyway.
 *
 * On success: `onRenamed` (the editor re-base — also refreshes the
 * doc.get cache, so the panel header's title + slug re-render), then
 * invalidate `doc.list` for the row. The 409 arm mirrors create: pick
 * a different title, retrying the same one can never succeed.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/docs.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/editor.spec.ts`).
 */

type RenameState =
  | { kind: "idle" }
  | { kind: "renaming" }
  | { kind: "failed"; failure: RenameFailure };

export function RenameDoc({
  docId,
  currentTitle,
  disabled,
  onRenamed,
}: {
  docId: string;
  currentTitle: string;
  disabled: boolean;
  onRenamed: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(currentTitle);
  const [state, setState] = useState<RenameState>({ kind: "idle" });

  // The trigger unmounts when the form replaces it, so focus management
  // IS the disclosure announcement: the title input takes focus on open.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  function handleOpen(): void {
    setTitle(currentTitle);
    setOpen(true);
  }

  function handleCancel(): void {
    setOpen(false);
    setState({ kind: "idle" });
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "" || state.kind === "renaming") return;
    if (trimmed === currentTitle) {
      handleCancel();
      return;
    }
    setState({ kind: "renaming" });
    try {
      await renameDoc(docId, trimmed);
      await onRenamed();
      await queryClient.invalidateQueries({ queryKey: DOC_LIST_QUERY_KEY });
      setOpen(false);
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "failed", failure: classifyRenameError(error) });
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={handleOpen}
        disabled={disabled}
        title={disabled ? "Save your edits first" : undefined}
      >
        Rename
      </button>
    );
  }

  const renaming = state.kind === "renaming";
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
        disabled={renaming}
      />
      <button
        type="submit"
        className="btn btn--ultra btn--sm"
        disabled={renaming || title.trim() === ""}
      >
        {renaming ? "Renaming…" : "Apply"}
      </button>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={handleCancel}
        disabled={renaming}
      >
        Cancel
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          {renameFailureMessage(state.failure)}
        </span>
      ) : null}
    </form>
  );
}
