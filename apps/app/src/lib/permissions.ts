/**
 * `permission.list` data-layer — the doc screen's Sharing panel cell
 * (invariant 4, ADR 0040 Step 8 / the administer-tier visibility rule).
 *
 * Same split as `audit.ts`: a plain testable fetcher + the react-query
 * binding, with every display decision (subject/grantor labels, the
 * guest marker, UTC timestamps via `formatAuditTime`) here so the
 * component stays render-only.
 *
 * **Raw ids are the v1 display, deliberately** — the audit-screen
 * precedent: no capability resolves an id to a name yet (the
 * identity-resolution cluster, `docs/adr/research-identity-resolution.md`),
 * and inventing warmth would mean lying about what the system knows.
 * When that ADR lands, names arrive here as display sugar on the same
 * wire rows — no shape change.
 *
 * **No 403 classify vocabulary, on purpose** (the `audit.ts` precedent):
 * `permission.list` is administer-gated, but today's only browser
 * principal IS the genesis owner (the registration gate, ADR 0041), who
 * administers every doc they can open — a denied arm would be dead
 * chrome. The panel renders one generic failure line for transport
 * errors; a reachable deny arm arrives with multi-member workspaces.
 *
 * Cursor pagination mirrors `audit.ts`: `{before_created_at,
 * before_grant_id}` both-or-neither, `next_cursor: null` ends the list,
 * `getNextPageParam` chains the wire cursor verbatim. The page size
 * stays at the wire default (50): a doc's ACL panel rarely paginates —
 * the "Load more" arm exists for honesty (no silent truncation), with
 * its mechanics pinned here rather than e2e-driven.
 */
import { type ApiClient, ApiError } from "@editorzero/api-client";
import { infiniteQueryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { shortId } from "./audit";
import { readErrorCode } from "./wire-error";

type PermissionListResponse = Awaited<ReturnType<ApiClient["permissions"]["list"]["$get"]>>;
// Typed error envelopes ride alongside the 200 — extract the success arm
// by its literal status before deriving the body (the docs.ts pattern).
type PermissionListSuccess = Extract<PermissionListResponse, { status: 200 }>;
export type PermissionList = Awaited<ReturnType<PermissionListSuccess["json"]>>;
export type GrantRow = PermissionList["grants"][number];
export type GrantCursor = NonNullable<PermissionList["next_cursor"]>;
export type GrantResourceKind = GrantRow["resource_kind"];

/** Wire default — see the header comment for why it isn't undercut here. */
export const PERMISSION_PAGE_SIZE = 50;

export function grantListQueryKey(
  kind: GrantResourceKind,
  resourceId: string,
): readonly [string, GrantResourceKind, string] {
  return ["permission.list", kind, resourceId] as const;
}

/**
 * Fetch one page of a resource's ACL edges, newest first. `cursor` is
 * the previous page's `next_cursor`; `null` asks for the head. Cursor
 * keys are omitted entirely on the first page — the input schema is
 * `.strict()` and refines the pair to both-or-neither.
 */
export async function fetchGrantPage(
  kind: GrantResourceKind,
  resourceId: string,
  cursor: GrantCursor | null,
  client: ApiClient = apiClient,
): Promise<PermissionList> {
  const res = await client.permissions.list.$get({
    query: {
      resource_kind: kind,
      resource_id: resourceId,
      limit: String(PERMISSION_PAGE_SIZE),
      ...(cursor !== null && {
        before_created_at: String(cursor.before_created_at),
        before_grant_id: cursor.before_grant_id,
      }),
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

/** Typed `null` so `initialPageParam` infers `GrantCursor | null`, not `null`. */
const FIRST_PAGE: GrantCursor | null = null;

export function grantListInfiniteOptions(
  kind: GrantResourceKind,
  resourceId: string,
  client: ApiClient = apiClient,
) {
  return infiniteQueryOptions({
    queryKey: grantListQueryKey(kind, resourceId),
    queryFn: ({ pageParam }) => fetchGrantPage(kind, resourceId, pageParam, client),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  });
}

/** `user 01961a2b…` / `agent 0196f00d…` — kind + abbreviated id (the audit label shape). */
export function grantSubjectLabel(row: Pick<GrantRow, "subject_kind" | "subject_id">): string {
  return `${row.subject_kind} ${shortId(row.subject_id)}`;
}

/**
 * Grantor attribution; `created_by` is always a user id (agents grant
 * as their delegator). Param is structural `string` — branded ids flow
 * in; a display label has no business demanding the brand.
 */
export function grantGrantedByLabel(row: { created_by: string }): string {
  return `user ${shortId(row.created_by)}`;
}

/**
 * The guest-edge marker — surfacing the audited cross-space escape
 * hatches is what the panel is FOR (the `permission.list` schema's own
 * words), so guest edges get the warn chip; the chip TEXT carries the
 * meaning (WCAG 1.4.1). Standing-backed edges show nothing.
 */
export function grantGuestMarker(row: Pick<GrantRow, "is_guest">): string | null {
  return row.is_guest === 1 ? "guest" : null;
}
