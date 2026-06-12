/**
 * `collection.list` + `collection.create` data-layer — the sidebar
 * Collections tree's capability cells (invariant 4, ADR 0033 §3 / 0040
 * H11).
 *
 * Same split as `workspace.ts`: `fetchCollectionList` is the testable
 * plain function, `collectionListQueryOptions` the react-query binding
 * (warmed by the `_authed` layout — the tree renders on every authed
 * screen — and read back there via direct `useQuery`). The tree itself is the pure
 * `flattenCollectionTree` — the wire is a FLAT array ordered by
 * `order_key` (creation order in v1); nesting is a client-side
 * assembly, so it lives here where it is unit-testable and the chrome
 * component stays render-only.
 */
import { type ApiClient, ApiError, isApiError } from "@editorzero/api-client";
import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { readErrorCode } from "./wire-error";

type CollectionListResponse = Awaited<ReturnType<ApiClient["collections"]["list"]["$get"]>>;
type CollectionListSuccess = Extract<CollectionListResponse, { status: 200 }>;
export type CollectionList = Awaited<ReturnType<CollectionListSuccess["json"]>>;
export type CollectionSummary = CollectionList["collections"][number];

export const COLLECTION_LIST_QUERY_KEY = ["collection.list"] as const;

export async function fetchCollectionList(client: ApiClient = apiClient): Promise<CollectionList> {
  const res = await client.collections.list.$get();
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function collectionListQueryOptions(client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: COLLECTION_LIST_QUERY_KEY,
    queryFn: () => fetchCollectionList(client),
  });
}

type CollectionCreateResponse = Awaited<ReturnType<ApiClient["collections"]["create"]["$post"]>>;
// 201 Created, matching doc.create — extract that arm from the union.
type CollectionCreateSuccess = Extract<CollectionCreateResponse, { status: 201 }>;
export type CollectionCreated = Awaited<ReturnType<CollectionCreateSuccess["json"]>>;

/**
 * Create a collection at the workspace root (the bare cell sends
 * `title` only — a parent/space picker is a later increment with the
 * tree screens; omitted `parent_id` = root, omitted `space_id` = the
 * legacy no-space bucket). Success re-renders the tree via the list
 * invalidation; there is no collection screen to navigate to yet.
 */
export async function createCollection(
  title: string,
  client: ApiClient = apiClient,
): Promise<CollectionCreated> {
  const res = await client.collections.create.$post({ json: { title } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type CollectionCreateFailure = "duplicate_title" | "create_failed";

/**
 * Same 409 rule as the doc forms: the capability refuses a sibling-slug
 * collision (collection.create has the NULL-aware pre-check — it was
 * the originating pattern doc.create mirrored), so retrying the same
 * title can never succeed; everything else is a generic retryable
 * failure.
 */
export function classifyCollectionCreateError(error: unknown): CollectionCreateFailure {
  return isApiError(error) && error.status === 409 ? "duplicate_title" : "create_failed";
}

export function collectionCreateFailureMessage(kind: CollectionCreateFailure): string {
  return kind === "duplicate_title"
    ? "A collection with this title already exists here. Pick a different title."
    : "Create failed. Try again.";
}

/** One renderable tree row: the summary plus its computed depth. */
export type CollectionTreeRow = {
  readonly id: CollectionSummary["id"];
  readonly title: string;
  readonly depth: number;
  readonly hasChildren: boolean;
};

/**
 * Flatten the wire's flat, `order_key`-ordered array into DFS render
 * order with depths. Children keep their wire order under each parent
 * (stable filter — the server's ordering contract carries through).
 *
 * Totality over what the table can hold, not just what live writes
 * produce:
 *   - **Orphans render as roots.** A live child under a TRASHED parent
 *     is reachable state (`collection.delete` trashes a row; the list
 *     excludes trashed rows, so the child's `parent_id` points at
 *     nothing visible). Hiding it would make a reachable collection
 *     un-navigable; promoting it to root level keeps it visible —
 *     after its true roots, in wire order.
 *   - **Nothing the wire returns is ever hidden.** A corrupt parent
 *     CYCLE (impossible to mint through capabilities — `collection.move`
 *     refuses) has no root to enter through, so the DFS misses its rows;
 *     a final sweep appends every unvisited row at root depth in wire
 *     order instead of silently dropping it. Each row renders exactly
 *     once; the walk always terminates.
 */
export function flattenCollectionTree(
  collections: readonly CollectionSummary[],
): CollectionTreeRow[] {
  const byParent = new Map<string | null, CollectionSummary[]>();
  const ids = new Set<string>(collections.map((c) => c.id));
  for (const collection of collections) {
    // A parent_id pointing outside the visible set is an orphan —
    // bucket under null so it renders at root level.
    const key =
      collection.parent_id !== null && ids.has(collection.parent_id) ? collection.parent_id : null;
    const siblings = byParent.get(key);
    if (siblings === undefined) {
      byParent.set(key, [collection]);
    } else {
      siblings.push(collection);
    }
  }

  const rows: CollectionTreeRow[] = [];
  const visited = new Set<string>();
  const emit = (parentKey: string | null, depth: number): void => {
    for (const collection of byParent.get(parentKey) ?? []) {
      const hasChildren = byParent.has(collection.id);
      rows.push({ id: collection.id, title: collection.title, depth, hasChildren });
      visited.add(collection.id);
      emit(collection.id, depth + 1);
    }
  };
  emit(null, 0);
  for (const collection of collections) {
    if (!visited.has(collection.id)) {
      rows.push({ id: collection.id, title: collection.title, depth: 0, hasChildren: false });
    }
  }
  return rows;
}

/**
 * The token sheet's tree indents two levels (`.ind` 26px / `.ind2`
 * 42px — a 10 + 16·depth scale). Collections nest arbitrarily deep, so
 * past depth 2 the same scale continues inline; the classes stay
 * canonical where they exist.
 */
export function treeRowIndent(depth: number): { className: string; padding: string | undefined } {
  if (depth <= 0) return { className: "row", padding: undefined };
  if (depth === 1) return { className: "row ind", padding: undefined };
  if (depth === 2) return { className: "row ind2", padding: undefined };
  return { className: "row", padding: `${10 + 16 * depth}px` };
}

/**
 * The placement BUCKET a collection id resolves to: `null` is the
 * legacy no-space bucket (workspace root, or a collection without a
 * space binding); a string is the bound space's id. `doc.move`'s
 * policy rails key on source-vs-target bucket (ADR 0040 Step 8): a
 * crossing REQUIRES an `acl_policy`, same-bucket REFUSES one — and the
 * wire's ValidationError envelope is code-generic, so the browser
 * derives the bucket here instead of discovering it via a refused
 * round-trip. A collection id missing from the live list (trashed —
 * anomalous placement) degrades to `null`; the server rails stay the
 * authority and the generic failure arm covers the residual.
 */
export function placementBinding(
  collectionId: string | null,
  collections: readonly CollectionSummary[],
): string | null {
  if (collectionId === null) return null;
  return collections.find((c) => c.id === collectionId)?.space_id ?? null;
}

/** The doc header's placement label: workspace root or the collection title. */
export function docPlacementLabel(
  collectionId: string | null,
  collections: readonly CollectionSummary[],
): string {
  if (collectionId === null) return "root";
  return collections.find((c) => c.id === collectionId)?.title ?? "unknown collection";
}
