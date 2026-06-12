/**
 * `workspace.get` + `workspace.update` data-layer — the sidebar
 * identity block's and the `/workspace` settings screen's capability
 * cells (invariant 4, ADR 0033 §3 / 0040 H11).
 *
 * Same split as `session.ts`/`docs.ts`: `fetchWorkspaceGet` is the
 * testable plain function; `workspaceGetQueryOptions` is the
 * react-query binding consumed by the `_authed` layout — `beforeLoad`
 * warms it (`ensureQueryData`; the block renders on every authed
 * screen, so the layout is the warm point) and the layout component
 * reads the cache back through a direct `useQuery` (route files are
 * e2e-covered, the doc.list pattern — no hook indirection here). `workspaceMonogram`
 * lives here so the chrome component stays render-only.
 *
 * `WorkspaceGet` is DERIVED from the materialized client type (SSOT —
 * the wire schema `WorkspaceGetOutputSchema` is server-side; the `hc`
 * client type is the browser-safe projection).
 */
import { type ApiClient, ApiError, isApiError } from "@editorzero/api-client";
import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { readErrorCode } from "./wire-error";

type WorkspaceGetResponse = Awaited<ReturnType<ApiClient["workspaces"]["get"]["$get"]>>;
// Typed error envelopes ride alongside the 200 — extract the success
// arm by its literal status before deriving the body (the docs.ts
// pattern).
type WorkspaceGetSuccess = Extract<WorkspaceGetResponse, { status: 200 }>;
export type WorkspaceGet = Awaited<ReturnType<WorkspaceGetSuccess["json"]>>;

export const WORKSPACE_GET_QUERY_KEY = ["workspace.get"] as const;

/**
 * Fetch the caller's workspace metadata. `res.ok` narrowing keeps the
 * happy path cast-free; the error arm goes through the shared envelope
 * reader so react-query surfaces a typed `ApiError`.
 */
export async function fetchWorkspaceGet(client: ApiClient = apiClient): Promise<WorkspaceGet> {
  const res = await client.workspaces.get.$get();
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function workspaceGetQueryOptions(client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: WORKSPACE_GET_QUERY_KEY,
    queryFn: () => fetchWorkspaceGet(client),
  });
}

/**
 * The identity block's avatar letter: first character of the workspace
 * name, uppercased. The genesis name is always non-empty by
 * construction (`${localPart}'s workspace`) and `workspace.update`
 * rejects empty names — the "?" arm is totality, not an expected state.
 */
export function workspaceMonogram(name: string): string {
  const first = name.trim().charAt(0);
  return first === "" ? "?" : first.toUpperCase();
}

type WorkspaceUpdateResponse = Awaited<ReturnType<ApiClient["workspaces"]["update"]["$post"]>>;
type WorkspaceUpdateSuccess = Extract<WorkspaceUpdateResponse, { status: 200 }>;
export type WorkspaceUpdated = Awaited<ReturnType<WorkspaceUpdateSuccess["json"]>>;

/**
 * The v1 mutable subset the settings form offers: `name` +
 * `trash_retention_days` (int, 7–365 — ADR 0017's bounds, mirrored as
 * the form input's native min/max). `slug` is immutable BY THE
 * CAPABILITY (bootstrap-derived; re-slugging would orphan outbound
 * links — a future `workspace.rename` owns slug-history semantics),
 * and the free-form `settings` record has no UI shape yet.
 */
export type WorkspacePatch = {
  name?: string;
  trash_retention_days?: number;
};

/**
 * Compute the wire patch from the form draft: only CHANGED fields
 * travel; an empty diff returns null and the form closes without a
 * wire call. A NaN retention (cleared number input) is no instruction
 * — the field simply doesn't travel.
 */
export function diffWorkspacePatch(
  current: Pick<WorkspaceGet, "name" | "trash_retention_days">,
  draft: { name: string; trash_retention_days: number },
): WorkspacePatch | null {
  const patch: WorkspacePatch = {};
  const name = draft.name.trim();
  if (name !== "" && name !== current.name) patch.name = name;
  if (
    !Number.isNaN(draft.trash_retention_days) &&
    draft.trash_retention_days !== current.trash_retention_days
  ) {
    patch.trash_retention_days = draft.trash_retention_days;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Patch the caller's workspace (`workspace:admin` — owner/admin only). */
export async function updateWorkspace(
  patch: WorkspacePatch,
  client: ApiClient = apiClient,
): Promise<WorkspaceUpdated> {
  const res = await client.workspaces.update.$post({ json: patch });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type WorkspaceUpdateFailure = "not_allowed" | "update_failed";

/**
 * 403 gets its own arm: members/guests hold no `workspace:admin`, and
 * "try again" would be a lie — the caller's ROLE is the blocker.
 */
export function classifyWorkspaceUpdateError(error: unknown): WorkspaceUpdateFailure {
  return isApiError(error) && error.status === 403 ? "not_allowed" : "update_failed";
}

export function workspaceUpdateFailureMessage(kind: WorkspaceUpdateFailure): string {
  return kind === "not_allowed"
    ? "Only workspace owners and admins can change these settings."
    : "Update failed. Try again.";
}
