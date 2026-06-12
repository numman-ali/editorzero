/**
 * `space.list` + `space.get` + `space.create` + `space.update` +
 * `space.archive` data-layer — the Spaces screens' capability cells
 * (invariant 4, ADR 0033 §3 / 0040 H11).
 *
 * Same split as `docs.ts`: `fetchSpaceList` is the testable plain
 * function; `spaceListQueryOptions` is the react-query binding consumed
 * by BOTH the route loader (`ensureQueryData`) and the component
 * (`useSuspenseQuery`). The presentational helpers live here so the
 * route component stays render-only (excluded from unit coverage;
 * proven by the marked Playwright spec in packages/e2e).
 *
 * `SpaceList` is DERIVED from the materialized client type (SSOT — the
 * wire schema `SpaceListOutputSchema` is server-side; the `hc` client
 * type is the browser-safe projection). The server orders rows
 * `name ASC, id ASC` (the capability's contract) — the screen renders
 * wire order and adds none of its own.
 */
import { type ApiClient, ApiError, isApiError } from "@editorzero/api-client";
import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { readErrorCode } from "./wire-error";

type SpaceListResponse = Awaited<ReturnType<ApiClient["spaces"]["list"]["$get"]>>;
// The handler returns typed error envelopes alongside the 200, so
// `json()` is a union — extract the success arm by its literal status
// before deriving the body (the docs.ts pattern).
type SpaceListSuccess = Extract<SpaceListResponse, { status: 200 }>;
export type SpaceList = Awaited<ReturnType<SpaceListSuccess["json"]>>;
export type SpaceSummary = SpaceList["spaces"][number];

export const SPACE_LIST_QUERY_KEY = ["space.list"] as const;

/**
 * Fetch the caller-visible spaces. `res.ok` narrowing keeps the happy
 * path cast-free; the error arm goes through the shared envelope reader
 * so react-query surfaces a typed `ApiError`.
 */
export async function fetchSpaceList(client: ApiClient = apiClient): Promise<SpaceList> {
  const res = await client.spaces.list.$get();
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function spaceListQueryOptions(client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: SPACE_LIST_QUERY_KEY,
    queryFn: () => fetchSpaceList(client),
  });
}

/**
 * Vocabulary lock (ADR 0040): the UI capitalises the wire's `kind`
 * values as chip labels — "Personal" is the signup-seeded owner space,
 * "Team" everything `space.create` mints.
 */
export function spaceKindLabel(kind: SpaceSummary["kind"]): string {
  return kind === "personal" ? "Personal" : "Team";
}

/**
 * The card's mono meta line: the org-shaping `type` plus the baseline
 * role it confers (`open` spaces grant the baseline to every member;
 * for `closed`/`private` the stored value is inert until a type
 * transition makes it live — render the row truth either way).
 */
export function spaceMetaLine(space: Pick<SpaceSummary, "type" | "baseline_access">): string {
  return `${space.type} · baseline ${space.baseline_access}`;
}

type SpaceGetResponse = Awaited<ReturnType<ApiClient["spaces"]["get"][":space_id"]["$get"]>>;
type SpaceGetSuccess = Extract<SpaceGetResponse, { status: 200 }>;
/** The full space row — `space.get` returns it verbatim (no wrapper). */
export type SpaceDetail = Awaited<ReturnType<SpaceGetSuccess["json"]>>;

export function spaceQueryKey(spaceId: string) {
  return ["space.get", spaceId] as const;
}

/**
 * Fetch one space. Visibility is the capability's two-rule gate
 * (baseline reach ∨ administer; personal = owner-only) — an invisible
 * or trashed space 404s, which the route loader surfaces through the
 * error boundary.
 */
export async function fetchSpace(
  spaceId: string,
  client: ApiClient = apiClient,
): Promise<SpaceDetail> {
  const res = await client.spaces.get[":space_id"].$get({ param: { space_id: spaceId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function spaceQueryOptions(spaceId: string, client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: spaceQueryKey(spaceId),
    queryFn: () => fetchSpace(spaceId, client),
  });
}

/** The org-shaping wire values, rendered verbatim in the form's select. */
export const SPACE_TYPES = ["open", "closed", "private"] as const;
export type SpaceType = (typeof SPACE_TYPES)[number];

type SpaceCreateResponse = Awaited<ReturnType<ApiClient["spaces"]["create"]["$post"]>>;
// This route answers 200 (not the docs/collections 201) — extract that arm.
type SpaceCreateSuccess = Extract<SpaceCreateResponse, { status: 200 }>;
export type SpaceCreated = Awaited<ReturnType<SpaceCreateSuccess["json"]>>;

/**
 * Create a TEAM space (the capability mints `kind = 'team'` only;
 * personal spaces are signup-seeded). `space_type` is the explicit
 * org-shaping choice; `baseline_access` stays at the schema default
 * (`view`) — the bare cell doesn't expose it (a later increment with
 * the space-update controls). Returns the full row echo; callers
 * navigate on `space_id`.
 */
export async function createSpace(
  name: string,
  spaceType: SpaceType,
  client: ApiClient = apiClient,
): Promise<SpaceCreated> {
  const res = await client.spaces.create.$post({ json: { name, space_type: spaceType } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type SpaceCreateFailure = "duplicate_name" | "create_failed";

/**
 * Same 409 rule as the doc/collection forms, scoped to the workspace
 * level (space slugs are workspace-unique): retrying the same name can
 * never succeed, so the 409 gets its own arm.
 */
export function classifySpaceCreateError(error: unknown): SpaceCreateFailure {
  return isApiError(error) && error.status === 409 ? "duplicate_name" : "create_failed";
}

export function spaceCreateFailureMessage(kind: SpaceCreateFailure): string {
  return kind === "duplicate_name"
    ? "A Space with this name already exists. Pick a different name."
    : "Create failed. Try again.";
}

/**
 * Baseline-access wire vocabulary (`BASELINE_ACCESS_ROLES` in
 * `@editorzero/scopes`), mirrored as a renderable const — the unit pin
 * + the e2e selectOption fail if the server vocabulary moves.
 */
export const SPACE_BASELINE_ROLES = ["edit", "comment", "view"] as const;
export type SpaceBaselineRole = (typeof SPACE_BASELINE_ROLES)[number];

type SpaceUpdateResponse = Awaited<ReturnType<ApiClient["spaces"]["update"][":space_id"]["$post"]>>;
type SpaceUpdateSuccess = Extract<SpaceUpdateResponse, { status: 200 }>;
export type SpaceUpdated = Awaited<ReturnType<SpaceUpdateSuccess["json"]>>;

/** The PATCH subset `space.update` accepts — at least one field. */
export type SpaceUpdatePatch = {
  name?: string;
  slug?: string;
  space_type?: SpaceType;
  baseline_access?: SpaceBaselineRole;
};

/**
 * Compute the wire patch from the form draft: only CHANGED fields
 * travel (the capability audits exactly what the caller sent — an
 * unchanged value would still be a judged transition), trimmed; an
 * empty diff returns null and the form closes without a wire call
 * (the rename-doc no-op precedent). Type/baseline are compared only
 * when the draft carries them — the personal-space form never offers
 * those fields (the model pins them; see EditSpace).
 */
export function diffSpacePatch(
  current: Pick<SpaceDetail, "name" | "slug" | "type" | "baseline_access">,
  draft: {
    name: string;
    slug: string;
    space_type?: SpaceType;
    baseline_access?: SpaceBaselineRole;
  },
): SpaceUpdatePatch | null {
  const patch: SpaceUpdatePatch = {};
  const name = draft.name.trim();
  const slug = draft.slug.trim();
  if (name !== "" && name !== current.name) patch.name = name;
  if (slug !== "" && slug !== current.slug) patch.slug = slug;
  if (draft.space_type !== undefined && draft.space_type !== current.type) {
    patch.space_type = draft.space_type;
  }
  if (draft.baseline_access !== undefined && draft.baseline_access !== current.baseline_access) {
    patch.baseline_access = draft.baseline_access;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * Patch a space. Authority is administer-tier (`assertCanAdministerSpace`
 * — personal: owner only; team: space owner-tier ∨ workspace owner/admin
 * backstop); a slug change re-runs the workspace-level sibling pre-check
 * (self-excluded) → typed 409.
 */
export async function updateSpace(
  spaceId: string,
  patch: SpaceUpdatePatch,
  client: ApiClient = apiClient,
): Promise<SpaceUpdated> {
  const res = await client.spaces.update[":space_id"].$post({
    param: { space_id: spaceId },
    json: patch,
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type SpaceUpdateFailure = "duplicate_slug" | "update_failed";

/** 409 = the explicit slug collided with a live sibling; unretryable as-is. */
export function classifySpaceUpdateError(error: unknown): SpaceUpdateFailure {
  return isApiError(error) && error.status === 409 ? "duplicate_slug" : "update_failed";
}

export function spaceUpdateFailureMessage(kind: SpaceUpdateFailure): string {
  return kind === "duplicate_slug"
    ? "A Space with this slug already exists. Pick a different slug."
    : "Update failed. Try again.";
}

type SpaceArchiveResponse = Awaited<
  ReturnType<ApiClient["spaces"]["archive"][":space_id"]["$post"]>
>;
type SpaceArchiveSuccess = Extract<SpaceArchiveResponse, { status: 200 }>;
export type SpaceArchived = Awaited<ReturnType<SpaceArchiveSuccess["json"]>>;

/**
 * Soft-delete a space (`space.archive` — recoverable per invariant 6:
 * `space.restore` revives the row AND its ACL 1:1, grants ride
 * through). The capability REFUSES while live collections, docs, or
 * members remain (no cascade — ADR 0017 anchors soft-delete on a 1:1
 * inverse); the 409's counts don't cross the wire (code-only
 * envelope), so the browser arm is a static "empty it first". The
 * archived-spaces *listing* is the same capability gap as doc trash —
 * restore is reachable via API/CLI/MCP only for now.
 */
export async function archiveSpace(
  spaceId: string,
  client: ApiClient = apiClient,
): Promise<SpaceArchived> {
  const res = await client.spaces.archive[":space_id"].$post({ param: { space_id: spaceId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type SpaceArchiveFailure = "not_empty" | "archive_failed";

/** 409 = live descendants; emptying the space is the only path forward. */
export function classifySpaceArchiveError(error: unknown): SpaceArchiveFailure {
  return isApiError(error) && error.status === 409 ? "not_empty" : "archive_failed";
}

export function spaceArchiveFailureMessage(kind: SpaceArchiveFailure): string {
  return kind === "not_empty"
    ? "This Space still has collections, docs, or members in it. Empty it first."
    : "Archive failed. Try again.";
}
