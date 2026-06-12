/**
 * `doc.list` + `doc.create` data-layer — the list cell (the first Web UI
 * capability cell) and the create cell's policy half (invariant 4,
 * ADR 0033 §3 / 0040 H11).
 *
 * Same split as `session.ts`: `fetchDocList`/`createDoc` are the testable
 * plain functions; `docListQueryOptions` is the react-query binding
 * consumed by BOTH the route loader (`ensureQueryData` — data resolves
 * before the screen renders) and the component (`useSuspenseQuery` reads
 * the warmed cache). The presentational helpers (`docAccessModeLabel`,
 * `docTagClass`, `formatUpdated`) and the create-failure vocabulary live
 * here so the route + form components stay render/orchestration-only
 * (excluded from unit coverage; proven by the marked Playwright specs in
 * packages/e2e).
 *
 * `DocList` is DERIVED from the materialized client type (SSOT — the wire
 * schema `DocListOutputSchema` is server-side; the `hc` client type is the
 * browser-safe projection). Branded id fields stay branded because
 * apps/app declares `@editorzero/ids` (see session.ts NB).
 */
import { type ApiClient, ApiError, isApiError } from "@editorzero/api-client";
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

type DocCreateResponse = Awaited<ReturnType<ApiClient["docs"]["create"]["$post"]>>;
// `doc.create` answers 201 Created (see the route's status-code note);
// extract that arm — the others are the typed error envelopes.
type DocCreateSuccess = Extract<DocCreateResponse, { status: 201 }>;
export type DocCreated = Awaited<ReturnType<DocCreateSuccess["json"]>>;

/**
 * Create a doc at the workspace root (the bare cell takes no
 * `collection_id` — placing into a collection needs a picker, a later
 * increment). Returns the full 201 echo; callers navigate on `doc_id`.
 */
export async function createDoc(title: string, client: ApiClient = apiClient): Promise<DocCreated> {
  const res = await client.docs.create.$post({ json: { title } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type CreateFailure = "duplicate_title" | "create_failed";

/**
 * 409 is the one failure with its own UX arm: the capability refuses a
 * sibling-slug collision (two titles kebab-casing to the same slug at
 * the same level), so the user must pick a different title — retrying
 * the same one can never succeed. Everything else is a generic
 * retryable failure; auth-shaped errors bubble through the same surface
 * (the route guard owns session loss).
 */
export function classifyCreateError(error: unknown): CreateFailure {
  return isApiError(error) && error.status === 409 ? "duplicate_title" : "create_failed";
}

export function createFailureMessage(kind: CreateFailure): string {
  return kind === "duplicate_title"
    ? "A doc with this title already exists here. Pick a different title."
    : "Create failed. Try again.";
}

type DocRenameResponse = Awaited<ReturnType<ApiClient["docs"]["rename"][":doc_id"]["$post"]>>;
type DocRenameSuccess = Extract<DocRenameResponse, { status: 200 }>;
export type DocRenamed = Awaited<ReturnType<DocRenameSuccess["json"]>>;

/**
 * Rename a doc — the capability with real rename semantics (ADR 0038
 * title-slot rule): one audited mutation updates `docs.title`, re-derives
 * the slug ("slug tracks title" in v1), and rewrites the Y.Doc's
 * heading-1 title block through the owned write path. Editing the
 * heading in the canvas does NONE of that (a content op only) — which
 * is why the editor offers this as its own control.
 */
export async function renameDoc(
  docId: string,
  title: string,
  client: ApiClient = apiClient,
): Promise<DocRenamed> {
  const res = await client.docs.rename[":doc_id"].$post({
    param: { doc_id: docId },
    json: { title },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type RenameFailure = "duplicate_title" | "rename_failed";

/** Same 409 rule as `classifyCreateError` — the slug collision is sibling-scoped. */
export function classifyRenameError(error: unknown): RenameFailure {
  return isApiError(error) && error.status === 409 ? "duplicate_title" : "rename_failed";
}

export function renameFailureMessage(kind: RenameFailure): string {
  return kind === "duplicate_title"
    ? "A doc with this title already exists here. Pick a different title."
    : "Rename failed. Try again.";
}

type DocDeleteResponse = Awaited<ReturnType<ApiClient["docs"]["delete"][":doc_id"]["$post"]>>;
type DocDeleteSuccess = Extract<DocDeleteResponse, { status: 200 }>;
export type DocDeleted = Awaited<ReturnType<DocDeleteSuccess["json"]>>;

/**
 * Soft-delete a doc (`doc.delete` — recoverable by design, invariant 6:
 * `doc.restore` brings it back with ACL + content intact). The browser
 * Trash *screen* is a later cell — it needs a trash-listing capability
 * that doesn't exist yet — so for now restore is reachable via the
 * API/CLI/MCP surfaces only.
 */
export async function deleteDoc(docId: string, client: ApiClient = apiClient): Promise<DocDeleted> {
  const res = await client.docs.delete[":doc_id"].$post({ param: { doc_id: docId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

/** No typed arms beyond the generic — delete has no collision-class failure. */
export const DELETE_FAILED_MESSAGE = "Trash failed. Try again.";

type DocPublishResponse = Awaited<ReturnType<ApiClient["docs"]["publish"][":doc_id"]["$post"]>>;
type DocPublishSuccess = Extract<DocPublishResponse, { status: 200 }>;
export type DocPublished = Awaited<ReturnType<DocPublishSuccess["json"]>>;

/**
 * Publish a doc — the publish dimension is ORTHOGONAL to `access_mode`
 * (ADR 0040 Step 5): it mints `published_slug` (collision-suffixed,
 * not necessarily the doc slug) + stamps `published_at`. Idempotent:
 * re-publishing keeps the URL and the original timestamp. The public
 * reader route is a later slice — publishing today flips the state the
 * list's green chip renders.
 */
export async function publishDoc(
  docId: string,
  client: ApiClient = apiClient,
): Promise<DocPublished> {
  const res = await client.docs.publish[":doc_id"].$post({ param: { doc_id: docId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

type DocUnpublishResponse = Awaited<ReturnType<ApiClient["docs"]["unpublish"][":doc_id"]["$post"]>>;
type DocUnpublishSuccess = Extract<DocUnpublishResponse, { status: 200 }>;
export type DocUnpublished = Awaited<ReturnType<DocUnpublishSuccess["json"]>>;

/** Unpublish — clears the pair; a later re-publish mints a FRESH slug. */
export async function unpublishDoc(
  docId: string,
  client: ApiClient = apiClient,
): Promise<DocUnpublished> {
  const res = await client.docs.unpublish[":doc_id"].$post({ param: { doc_id: docId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

/** Generic-only failure arms — neither direction has a collision class. */
export function publishFailureMessage(direction: "publish" | "unpublish"): string {
  return direction === "publish" ? "Publish failed. Try again." : "Unpublish failed. Try again.";
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
