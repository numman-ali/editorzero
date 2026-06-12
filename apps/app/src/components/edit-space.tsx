import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { formatUpdated } from "../lib/docs";
import {
  classifySpaceUpdateError,
  diffSpacePatch,
  SPACE_BASELINE_ROLES,
  SPACE_LIST_QUERY_KEY,
  SPACE_TYPES,
  type SpaceBaselineRole,
  type SpaceDetail,
  type SpaceType,
  type SpaceUpdateFailure,
  spaceMetaLine,
  spaceQueryKey,
  spaceUpdateFailureMessage,
  updateSpace,
} from "../lib/spaces";

import "./inline-form.css";

/**
 * The `space.update × Web UI` cell: the space detail body — the `.kv`
 * fact rows with an "Edit space" disclosure that swaps them for the
 * PATCH form (the morph recipe at block scale: the facts ARE the
 * closed state).
 *
 * The form offers exactly the capability's mutable subset, shaped by
 * kind: name + slug for every space (cosmetic, always patchable —
 * space slugs are DELIBERATE, they do not track the name the way doc
 * slugs do), `space_type` + `baseline_access` selects for TEAM spaces
 * only — a personal space structurally pins both (the capability
 * refuses with `personal_space_type_pinned`; offering a control the
 * model refuses would be dishonest chrome).
 *
 * Only changed fields travel (`diffSpacePatch`, unit-tested); an
 * unchanged form closes without a wire call. Success invalidates
 * `space.get` (this screen re-renders from the fresh row) +
 * `space.list` (the grid card). The 409 arm is the explicit-slug
 * sibling collision; everything else gets the generic retry line.
 *
 * `children` render into the closed state's button row (the space's
 * other verbs — today the `space.archive` confirm); the open form
 * hides them, one mutation at a time.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/spaces.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/spaces.spec.ts`).
 */

type UpdateState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "failed"; failure: SpaceUpdateFailure };

export function EditSpace({ space, children }: { space: SpaceDetail; children?: ReactNode }) {
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(space.name);
  const [slug, setSlug] = useState(space.slug);
  const [spaceType, setSpaceType] = useState<SpaceType>(space.type);
  const [baseline, setBaseline] = useState<SpaceBaselineRole>(space.baseline_access);
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const team = space.kind === "team";

  // The trigger unmounts when the form replaces the facts, so focus
  // management IS the disclosure announcement.
  useEffect(() => {
    if (open) {
      nameRef.current?.focus();
    }
  }, [open]);

  function openForm(): void {
    // Prefill from the CURRENT row each open — the row may have been
    // refreshed since the last edit.
    setName(space.name);
    setSlug(space.slug);
    setSpaceType(space.type);
    setBaseline(space.baseline_access);
    setState({ kind: "idle" });
    setOpen(true);
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.kind === "saving") return;
    const patch = diffSpacePatch(
      space,
      team ? { name, slug, space_type: spaceType, baseline_access: baseline } : { name, slug },
    );
    if (patch === null) {
      setOpen(false);
      return;
    }
    setState({ kind: "saving" });
    try {
      await updateSpace(space.space_id, patch);
      await queryClient.invalidateQueries({ queryKey: spaceQueryKey(space.space_id) });
      await queryClient.invalidateQueries({ queryKey: SPACE_LIST_QUERY_KEY });
      setOpen(false);
      setState({ kind: "idle" });
    } catch (error) {
      setState({ kind: "failed", failure: classifySpaceUpdateError(error) });
    }
  }

  if (!open) {
    return (
      <div style={{ padding: "15px" }}>
        <div className="kv">
          <span className="k">access</span>
          <span className="v">{spaceMetaLine(space)}</span>
        </div>
        <div className="kv">
          <span className="k">created</span>
          <span className="v mono">{formatUpdated(space.created_at)}</span>
        </div>
        <div className="kv">
          <span className="k">updated</span>
          <span className="v mono">{formatUpdated(space.updated_at)}</span>
        </div>
        <div className="kv">
          <span className="k" />
          <span className="inlineform">
            <button type="button" className="btn btn--ghost btn--sm" onClick={openForm}>
              Edit space
            </button>
            {children}
          </span>
        </div>
      </div>
    );
  }

  const saving = state.kind === "saving";
  return (
    <div style={{ padding: "15px" }}>
      <form className="inlineform" onSubmit={(event) => void handleSubmit(event)}>
        <input
          ref={nameRef}
          className="inlineform-input"
          type="text"
          aria-label="Space name"
          placeholder="Space name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
        />
        <input
          className="inlineform-input"
          type="text"
          aria-label="Space slug"
          placeholder="space-slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          disabled={saving}
        />
        {team && (
          <>
            <select
              className="inlineform-select"
              aria-label="Space type"
              value={spaceType}
              onChange={(event) => {
                const next = SPACE_TYPES.find((t) => t === event.target.value);
                if (next !== undefined) setSpaceType(next);
              }}
              disabled={saving}
            >
              {SPACE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              className="inlineform-select"
              aria-label="Baseline access"
              value={baseline}
              onChange={(event) => {
                const next = SPACE_BASELINE_ROLES.find((r) => r === event.target.value);
                if (next !== undefined) setBaseline(next);
              }}
              disabled={saving}
            >
              {SPACE_BASELINE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="submit"
          className="btn btn--ultra btn--sm"
          disabled={saving || name.trim() === "" || slug.trim() === ""}
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
            {spaceUpdateFailureMessage(state.failure)}
          </span>
        ) : null}
      </form>
    </div>
  );
}
