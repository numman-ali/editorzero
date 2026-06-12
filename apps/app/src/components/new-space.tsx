import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  classifySpaceCreateError,
  createSpace,
  SPACE_LIST_QUERY_KEY,
  SPACE_TYPES,
  type SpaceCreateFailure,
  type SpaceType,
  spaceCreateFailureMessage,
} from "../lib/spaces";

import "./inline-form.css";

/**
 * The `space.create × Web UI` cell: the Spaces panel header's "+ New
 * space" affordance (the new-doc morph recipe — trigger unmounts, the
 * inline form takes focus). Two fields, both required by the wire:
 * the name (slug derives from it; sibling collision = 409) and the
 * org-shaping `space_type` select (open/closed/private rendered in
 * wire vocabulary — the same words the cards' meta lines show).
 * `baseline_access` stays at the schema default (`view`); exposing it
 * is a later increment with the space-update controls.
 *
 * On success: invalidate `space.list`, then navigate into the new
 * space's detail screen (`/space/$spaceId` — the create→detail
 * pattern, matching new-doc→editor). The capability mints TEAM spaces
 * only; personal spaces are signup-seeded (the kind↔owner CHECK makes
 * the pair structural).
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/spaces.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/spaces.spec.ts`).
 */

type CreateState =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "failed"; failure: SpaceCreateFailure };

export function NewSpace() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [spaceType, setSpaceType] = useState<SpaceType>("open");
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
      const created = await createSpace(trimmed, spaceType);
      await queryClient.invalidateQueries({ queryKey: SPACE_LIST_QUERY_KEY });
      await navigate({ to: "/space/$spaceId", params: { spaceId: created.space_id } });
    } catch (error) {
      setState({ kind: "failed", failure: classifySpaceCreateError(error) });
    }
  }

  function handleCancel(): void {
    setOpen(false);
    setName("");
    setSpaceType("open");
    setState({ kind: "idle" });
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--ultra btn--sm" onClick={() => setOpen(true)}>
        + New space
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
        aria-label="Space name"
        placeholder="Space name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={creating}
      />
      <select
        className="inlineform-select"
        aria-label="Space type"
        value={spaceType}
        onChange={(event) => {
          // The option values come from SPACE_TYPES verbatim, so the
          // change value is one of them by construction — find() narrows
          // without a cast.
          const next = SPACE_TYPES.find((t) => t === event.target.value);
          if (next !== undefined) setSpaceType(next);
        }}
        disabled={creating}
      >
        {SPACE_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
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
          {spaceCreateFailureMessage(state.failure)}
        </span>
      ) : null}
    </form>
  );
}
