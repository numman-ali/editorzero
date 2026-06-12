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

type CollectionUpdateResponse = Awaited<
  ReturnType<ApiClient["collections"]["update"][":collection_id"]["$post"]>
>;
type CollectionUpdateSuccess = Extract<CollectionUpdateResponse, { status: 200 }>;
export type CollectionUpdated = Awaited<ReturnType<CollectionUpdateSuccess["json"]>>;

/**
 * Retitle a collection — the capability's whole v1 mutable surface
 * (`slug` re-derives in the handler; placement changes belong to
 * `collection.move`). The form's no-change close happens in the
 * component; this always sends.
 */
export async function updateCollection(
  collectionId: string,
  title: string,
  client: ApiClient = apiClient,
): Promise<CollectionUpdated> {
  const res = await client.collections.update[":collection_id"].$post({
    param: { collection_id: collectionId },
    json: { title },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type CollectionUpdateFailure = "duplicate_title" | "missing" | "update_failed";

/**
 * 409 = the derived slug collides with a live sibling (retrying the
 * same title can never succeed); 404 = the collection vanished under
 * the screen (trashed elsewhere); everything else is retryable.
 */
export function classifyCollectionUpdateError(error: unknown): CollectionUpdateFailure {
  if (isApiError(error) && error.status === 409) return "duplicate_title";
  if (isApiError(error) && error.status === 404) return "missing";
  return "update_failed";
}

export function collectionUpdateFailureMessage(kind: CollectionUpdateFailure): string {
  switch (kind) {
    case "duplicate_title":
      return "A collection with this title already exists here. Pick a different title.";
    case "missing":
      return "This collection no longer exists. It may have been trashed elsewhere.";
    case "update_failed":
      return "Save failed. Try again.";
  }
}

type CollectionDeleteResponse = Awaited<
  ReturnType<ApiClient["collections"]["delete"][":collection_id"]["$post"]>
>;
type CollectionDeleteSuccess = Extract<CollectionDeleteResponse, { status: 200 }>;
export type CollectionDeleted = Awaited<ReturnType<CollectionDeleteSuccess["json"]>>;

/**
 * Soft-delete a collection (invariant 6 — `collection.restore` revives
 * it 1:1, though restore is API/CLI/MCP-only until a trash-listing
 * capability exists; the doc-trash gap class). The capability refuses
 * while live sub-collections or docs remain — no cascade; the caller
 * empties it first.
 */
export async function deleteCollection(
  collectionId: string,
  client: ApiClient = apiClient,
): Promise<CollectionDeleted> {
  const res = await client.collections.delete[":collection_id"].$post({
    param: { collection_id: collectionId },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type CollectionDeleteFailure = "not_empty" | "missing" | "delete_failed";

/** 409 `has_live_descendants` — counts do not cross the wire (code-only envelope). */
export function classifyCollectionDeleteError(error: unknown): CollectionDeleteFailure {
  if (isApiError(error) && error.status === 409) return "not_empty";
  if (isApiError(error) && error.status === 404) return "missing";
  return "delete_failed";
}

export function collectionDeleteFailureMessage(kind: CollectionDeleteFailure): string {
  switch (kind) {
    case "not_empty":
      return "This collection still has sub-collections or docs in it. Empty it first.";
    case "missing":
      return "This collection no longer exists. It may have been trashed already.";
    case "delete_failed":
      return "Delete failed. Try again.";
  }
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

/**
 * The detail screen's binding fact: `null` is the legacy no-space
 * bucket ("workspace"); otherwise the bound space's name. An id the
 * spaces list cannot resolve (archived under the screen) degrades to
 * the honest "unknown space" — the binding exists, its target is gone
 * from the live list.
 */
export function collectionSpaceLabel(
  spaceId: string | null,
  spaces: readonly { space_id: string; name: string }[],
): string {
  if (spaceId === null) return "workspace";
  return spaces.find((s) => s.space_id === spaceId)?.name ?? "unknown space";
}

/**
 * Every id in the subtree rooted at `collectionId` (the root included).
 * The Move destination select excludes this set — `collection.move`
 * refuses a cycle (moving a collection under itself or a descendant),
 * and excluding the options realizes that rail in chrome BY
 * CONSTRUCTION; the server stays authoritative. Children resolve by
 * `parent_id` edges over the live list; the walk visits each row at
 * most once, so even corrupt cycles terminate.
 */
export function collectionDescendantIds(
  collectionId: string,
  collections: readonly CollectionSummary[],
): ReadonlySet<string> {
  const subtree = new Set<string>([collectionId]);
  // Wire order is parent-before-child for live trees, but a single pass
  // does not depend on it: keep sweeping until no row joins the set.
  let grew = true;
  while (grew) {
    grew = false;
    for (const collection of collections) {
      if (
        collection.parent_id !== null &&
        subtree.has(collection.parent_id) &&
        !subtree.has(collection.id)
      ) {
        subtree.add(collection.id);
        grew = true;
      }
    }
  }
  return subtree;
}

type CollectionMoveArgs = Parameters<
  ApiClient["collections"]["move"][":collection_id"]["$post"]
>[0];
export type CollectionMoveDestination = CollectionMoveArgs["json"]["destination"];

/**
 * The Move select's value encoding: `""` is the workspace (legacy)
 * root, `space:<id>` a space root, anything else a collection id.
 * UUIDs can never collide with the prefix or the empty string.
 */
export const SPACE_DESTINATION_PREFIX = "space:";

export function parseMoveDestination(value: string): CollectionMoveDestination {
  if (value === "") return { kind: "legacy_root" };
  if (value.startsWith(SPACE_DESTINATION_PREFIX)) {
    return { kind: "space_root", space_id: value.slice(SPACE_DESTINATION_PREFIX.length) };
  }
  return { kind: "collection", collection_id: value };
}

/**
 * The placement bucket a DESTINATION resolves to (null = the legacy
 * bucket) — the crossing side of `collection.move`'s policy rail; the
 * source side is the moved collection's own `space_id`. Same authority
 * posture as `placementBinding`.
 */
export function destinationBinding(
  destination: CollectionMoveDestination,
  collections: readonly CollectionSummary[],
): string | null {
  switch (destination.kind) {
    case "legacy_root":
      return null;
    case "space_root":
      return destination.space_id;
    case "collection":
      return placementBinding(destination.collection_id, collections);
  }
}

type CollectionMoveResponse = Awaited<
  ReturnType<ApiClient["collections"]["move"][":collection_id"]["$post"]>
>;
type CollectionMoveSuccess = Extract<CollectionMoveResponse, { status: 200 }>;
export type CollectionMoved = Awaited<ReturnType<CollectionMoveSuccess["json"]>>;

/** Wire-derived policy vocabulary (shared with doc.move via the schemas SSOT). */
export type CollectionMovePolicy = CollectionMoveArgs["json"]["acl_policy"];

/**
 * Move a collection (re-parent and/or re-bind). `aclPolicy` travels
 * ONLY on a bucket crossing — the handler refuses it same-bucket and
 * demands it on a crossing (ADR 0040 §7; the doc.move contract over a
 * whole subtree). The conditional spread omits the key entirely.
 */
export async function moveCollection(
  collectionId: string,
  destination: CollectionMoveDestination,
  aclPolicy: CollectionMovePolicy,
  client: ApiClient = apiClient,
): Promise<CollectionMoved> {
  const res = await client.collections.move[":collection_id"].$post({
    param: { collection_id: collectionId },
    json: { destination, ...(aclPolicy !== undefined && { acl_policy: aclPolicy }) },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export type CollectionMoveFailure =
  | "destination_clash"
  | "target_missing"
  | "no_access"
  | "move_failed";

/**
 * 409 = the moved collection's slug collides with a live sibling at
 * the destination; 404 = the destination (or the collection itself)
 * vanished under the form. 403 = placement standing: the select offers
 * every space root, but baseline reach into a closed/private space
 * needs membership or a grant — even the workspace owner does not ride
 * an admin backstop into content placement (ADR 0040's privacy
 * posture), and no capability yet projects per-space reach for the
 * client to pre-filter the options (punch list). A retry line would
 * lie about a standing refusal. The cycle 400 is unreachable from this
 * UI — the select excludes the subtree by construction — so it falls
 * to the generic retry arm with the rest.
 */
export function classifyCollectionMoveError(error: unknown): CollectionMoveFailure {
  if (isApiError(error) && error.status === 409) return "destination_clash";
  if (isApiError(error) && error.status === 404) return "target_missing";
  if (isApiError(error) && error.status === 403) return "no_access";
  return "move_failed";
}

export function collectionMoveFailureMessage(kind: CollectionMoveFailure): string {
  switch (kind) {
    case "destination_clash":
      return "A collection with this title already exists at the destination. Rename one first.";
    case "target_missing":
      return "The destination no longer exists. Pick another.";
    case "no_access":
      return "You don't have access to place into that destination.";
    case "move_failed":
      return "Move failed. Try again.";
  }
}
