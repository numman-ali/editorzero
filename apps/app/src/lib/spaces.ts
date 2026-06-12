/**
 * `space.list` data-layer — the Spaces screen's capability cell
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
import { type ApiClient, ApiError } from "@editorzero/api-client";
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
