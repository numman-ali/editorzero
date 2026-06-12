/**
 * `doc.list` data-layer — the first Web UI capability cell (invariant 4,
 * ADR 0033 §3 / 0040 H11).
 *
 * Same split as `session.ts`: `fetchDocList` is the testable plain
 * function; `docListQueryOptions` is the react-query binding consumed by
 * BOTH the route loader (`ensureQueryData` — data resolves before the
 * screen renders) and the component (`useSuspenseQuery` reads the warmed
 * cache). The presentational helpers (`docAccessModeLabel`,
 * `docTagClass`, `formatUpdated`) live here so the route component
 * stays render-only (excluded from unit coverage; proven by the marked
 * Playwright spec in packages/e2e).
 *
 * `DocList` is DERIVED from the materialized client type (SSOT — the wire
 * schema `DocListOutputSchema` is server-side; the `hc` client type is the
 * browser-safe projection). Branded id fields stay branded because
 * apps/app declares `@editorzero/ids` (see session.ts NB).
 */
import { type ApiClient, ApiError } from "@editorzero/api-client";
import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { readErrorCode } from "./wire-error";

type DocListResponse = Awaited<ReturnType<ApiClient["docs"]["list"]["$get"]>>;
// Unlike whoami (200-only union), this route's handler returns typed error
// envelopes (401/403/500) alongside the 200, so `json()` is a union —
// extract the success arm by its literal status before deriving the body.
type DocListSuccess = Extract<DocListResponse, { status: 200 }>;
export type DocList = Awaited<ReturnType<DocListSuccess["json"]>>;
export type DocSummary = DocList["docs"][number];

export const DOC_LIST_QUERY_KEY = ["doc.list"] as const;

/**
 * Fetch the caller-visible docs. The `hc` union carries the typed error
 * arms (401/403/500) alongside the 200; `res.ok` narrowing keeps the
 * happy path cast-free, and the error arm goes through the shared
 * envelope reader so react-query surfaces a typed `ApiError`.
 */
export async function fetchDocList(client: ApiClient = apiClient): Promise<DocList> {
  const res = await client.docs.list.$get();
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function docListQueryOptions(client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: DOC_LIST_QUERY_KEY,
    queryFn: () => fetchDocList(client),
  });
}

/**
 * Vocabulary lock (ADR 0040): the UI says "Space" for the read-scope
 * value the wire calls `space` (the Step-5 `access_mode` split retired
 * the overloaded `visibility`). `private` renders verbatim (capitalized
 * by the chip's CSS `text-transform`).
 */
export function docAccessModeLabel(access_mode: DocSummary["access_mode"]): string {
  return access_mode === "space" ? "Space" : access_mode;
}

/**
 * Chip modifier: `st-pub` (the published-green token pair) marks the
 * PUBLISH dimension — orthogonal to `access_mode` (ADR 0040 Step 5).
 * `published_at IS NOT NULL` is the publish predicate, so a published
 * doc's chip goes green while still labelling its read scope;
 * unpublished docs keep the base `.status-tag` outline.
 */
export function docTagClass(published_at: DocSummary["published_at"]): string {
  return published_at !== null ? "status-tag st-pub" : "status-tag";
}

/**
 * Deterministic UTC date (YYYY-MM-DD) for the `when` column — relative
 * times ("2h ago") would make unit + e2e assertions clock-dependent.
 */
export function formatUpdated(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}
