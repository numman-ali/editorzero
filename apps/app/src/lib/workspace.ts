/**
 * `workspace.get` data-layer — the sidebar workspace identity block's
 * capability cell (invariant 4, ADR 0033 §3 / 0040 H11).
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
import { type ApiClient, ApiError } from "@editorzero/api-client";
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
