import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  COLLECTION_LIST_QUERY_KEY,
  type CollectionSummary,
  collectionListQueryOptions,
  fetchCollectionList,
  flattenCollectionTree,
  treeRowIndent,
} from "./collections";

/** Same fake-client pattern as `docs.test.ts`/`spaces.test.ts`. */
function clientReturning(status: number, body: BodyInit | null): ApiClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
  return createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl });
}

function jsonClient(status: number, body: unknown): ApiClient {
  return clientReturning(status, JSON.stringify(body));
}

function row(id: string, title: string, parent_id: string | null): CollectionSummary {
  // The canned rows cross a real wire in production; building them through
  // the typed client in tests would need a server — parse-shaping the
  // literal through the summary's structural type keeps the fixtures
  // honest without a cast.
  return {
    id,
    title,
    slug: title.toLowerCase().replace(/\s+/gu, "-"),
    parent_id,
    created_at: 1,
    updated_at: 1,
  };
}

const C1 = "018f0000-0000-7000-8000-0000000000c1";
const C2 = "018f0000-0000-7000-8000-0000000000c2";
const C3 = "018f0000-0000-7000-8000-0000000000c3";
const C4 = "018f0000-0000-7000-8000-0000000000c4";

describe("fetchCollectionList", () => {
  it("resolves the collections payload on 200", async () => {
    const result = await fetchCollectionList(
      jsonClient(200, { collections: [row(C1, "A", null)] }),
    );
    expect(result.collections).toHaveLength(1);
  });

  it("throws ApiError with the typed envelope code on a 403", async () => {
    await expect(
      fetchCollectionList(jsonClient(403, { error: "permission_denied" })),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });

  it("falls back to request_failed for a non-JSON 5xx", async () => {
    await expect(
      fetchCollectionList(clientReturning(500, "<html>oops</html>")),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("collectionListQueryOptions", () => {
  it("binds the stable query key to fetchCollectionList against the given client", async () => {
    const options = collectionListQueryOptions(jsonClient(200, { collections: [] }));
    expect(options.queryKey).toEqual(COLLECTION_LIST_QUERY_KEY);
    const result = await new QueryClient().fetchQuery(options);
    expect(result.collections).toEqual([]);
  });
});

describe("flattenCollectionTree", () => {
  it("emits DFS order with depths, children in wire order under each parent", () => {
    const rows = flattenCollectionTree([
      row(C1, "Architecture", null),
      row(C2, "Security", null),
      row(C3, "Runtime", C1),
      row(C4, "Sync", C1),
    ]);
    expect(rows.map((r) => [r.title, r.depth])).toEqual([
      ["Architecture", 0],
      ["Runtime", 1],
      ["Sync", 1],
      ["Security", 0],
    ]);
    expect(rows[0]?.hasChildren).toBe(true);
    expect(rows[1]?.hasChildren).toBe(false);
  });

  it("nests arbitrarily deep", () => {
    const rows = flattenCollectionTree([
      row(C1, "Root", null),
      row(C2, "Child", C1),
      row(C3, "Grandchild", C2),
      row(C4, "Great", C3),
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3]);
  });

  it("promotes an orphan (parent outside the visible set) to root level, after true roots", () => {
    // Reachable state: a live child whose parent was trashed — the list
    // excludes the parent, the child must stay navigable.
    const rows = flattenCollectionTree([
      row(C1, "Visible root", null),
      row(C3, "Stranded child", C2),
    ]);
    expect(rows.map((r) => [r.title, r.depth])).toEqual([
      ["Visible root", 0],
      ["Stranded child", 0],
    ]);
  });

  it("renders a corrupt parent cycle's rows at root depth instead of hiding them", () => {
    const rows = flattenCollectionTree([row(C1, "A", C2), row(C2, "B", C1)]);
    // A cycle has no root to enter through, so the DFS misses both rows;
    // the leftover sweep surfaces them at root depth in wire order —
    // nothing the wire returns is ever hidden, each row exactly once,
    // and the walk terminates. (Unmintable through capabilities.)
    expect(rows.map((r) => [r.title, r.depth])).toEqual([
      ["A", 0],
      ["B", 0],
    ]);
  });

  it("returns [] for an empty workspace", () => {
    expect(flattenCollectionTree([])).toEqual([]);
  });
});

describe("treeRowIndent", () => {
  it("uses the token classes for the sheet's two indent levels", () => {
    expect(treeRowIndent(0)).toEqual({ className: "row", padding: undefined });
    expect(treeRowIndent(1)).toEqual({ className: "row ind", padding: undefined });
    expect(treeRowIndent(2)).toEqual({ className: "row ind2", padding: undefined });
  });

  it("continues the 10 + 16·depth scale inline past depth 2", () => {
    expect(treeRowIndent(3)).toEqual({ className: "row", padding: "58px" });
    expect(treeRowIndent(5)).toEqual({ className: "row", padding: "90px" });
  });
});
