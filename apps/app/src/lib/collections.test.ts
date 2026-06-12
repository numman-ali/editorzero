import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  COLLECTION_LIST_QUERY_KEY,
  type CollectionSummary,
  classifyCollectionCreateError,
  classifyCollectionDeleteError,
  classifyCollectionMoveError,
  classifyCollectionUpdateError,
  collectionCreateFailureMessage,
  collectionDeleteFailureMessage,
  collectionDescendantIds,
  collectionListQueryOptions,
  collectionMoveFailureMessage,
  collectionSpaceLabel,
  collectionUpdateFailureMessage,
  createCollection,
  deleteCollection,
  destinationBinding,
  docPlacementLabel,
  fetchCollectionList,
  flattenCollectionTree,
  moveCollection,
  parseMoveDestination,
  placementBinding,
  treeRowIndent,
  updateCollection,
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
    space_id: null,
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

const CREATED = {
  collection_id: "018f0000-0000-7000-8000-0000000000c9",
  workspace_id: "018f0000-0000-7000-8000-0000000000aa",
  parent_id: null,
  space_id: null,
  title: "Receipts",
  slug: "receipts",
  order_key: "a0",
  created_by: "018f0000-0000-7000-8000-0000000000bb",
};

describe("createCollection", () => {
  it("resolves the 201 echo (the tree re-renders via list invalidation)", async () => {
    const created = await createCollection("Receipts", jsonClient(201, CREATED));
    expect(created.collection_id).toBe(CREATED.collection_id);
    expect(created.slug).toBe("receipts");
  });

  it("throws ApiError with the typed envelope code on a 409 slug collision", async () => {
    await expect(
      createCollection("Receipts", jsonClient(409, { error: "slug_collision" })),
    ).rejects.toMatchObject({ status: 409, code: "slug_collision" });
  });

  it("throws an ApiError instance on a 400", async () => {
    await expect(
      createCollection("", jsonClient(400, { error: "validation_failed" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("classifyCollectionCreateError (the doc-form 409 rule)", () => {
  it("maps a 409 ApiError to duplicate_title", () => {
    expect(classifyCollectionCreateError(new ApiError(409, "slug_collision"))).toBe(
      "duplicate_title",
    );
  });

  it("maps other ApiErrors to create_failed", () => {
    expect(classifyCollectionCreateError(new ApiError(500, "internal"))).toBe("create_failed");
  });

  it("maps non-ApiError throwables (network faults) to create_failed", () => {
    expect(classifyCollectionCreateError(new TypeError("fetch failed"))).toBe("create_failed");
  });
});

describe("collectionCreateFailureMessage", () => {
  it("tells the user to pick a different title on duplicate_title", () => {
    expect(collectionCreateFailureMessage("duplicate_title")).toContain("already exists");
  });

  it("offers a retry on create_failed", () => {
    expect(collectionCreateFailureMessage("create_failed")).toContain("Try again");
  });
});

describe("placementBinding (the doc.move bucket derivation)", () => {
  const SPACE = "018f0000-0000-7000-8000-00000000aaaa";
  const bound: CollectionSummary = { ...row(C1, "Bound", null), space_id: SPACE };
  const legacy = row("018f0000-0000-7000-8000-0000000000c2", "Legacy", null);

  it("workspace root is the legacy bucket", () => {
    expect(placementBinding(null, [bound, legacy])).toBeNull();
  });

  it("a bound collection resolves to its space; an unbound one to legacy", () => {
    expect(placementBinding(bound.id, [bound, legacy])).toBe(SPACE);
    expect(placementBinding(legacy.id, [bound, legacy])).toBeNull();
  });

  it("an id missing from the live list degrades to legacy (server rails stay authoritative)", () => {
    expect(placementBinding("018f0000-0000-7000-8000-00000000dead", [bound])).toBeNull();
  });

  it("crossing = binding inequality (root→bound crosses; root→legacy does not)", () => {
    const cols = [bound, legacy];
    expect(placementBinding(null, cols) !== placementBinding(bound.id, cols)).toBe(true);
    expect(placementBinding(null, cols) !== placementBinding(legacy.id, cols)).toBe(false);
  });
});

describe("docPlacementLabel", () => {
  it("renders root, a collection title, or the honest unknown", () => {
    const c = row(C1, "Field Guides", null);
    expect(docPlacementLabel(null, [c])).toBe("root");
    expect(docPlacementLabel(C1, [c])).toBe("Field Guides");
    expect(docPlacementLabel("018f0000-0000-7000-8000-00000000dead", [c])).toBe(
      "unknown collection",
    );
  });
});

describe("updateCollection", () => {
  it("returns the typed post-state on 200", async () => {
    const body = {
      collection_id: C1,
      title: "Receipt Ledger",
      slug: "receipt-ledger",
      updated_at: 9,
    };
    const result = await updateCollection(C1, "Receipt Ledger", jsonClient(200, body));
    expect(result.title).toBe("Receipt Ledger");
    expect(result.slug).toBe("receipt-ledger");
  });

  it("throws a typed ApiError on the sibling-slug 409", async () => {
    await expect(
      updateCollection(C1, "Field Guides", jsonClient(409, { error: "slug_collision" })),
    ).rejects.toThrow(new ApiError(409, "slug_collision"));
  });
});

describe("classifyCollectionUpdateError", () => {
  it("maps 409 to duplicate_title, 404 to missing, the rest to update_failed", () => {
    expect(classifyCollectionUpdateError(new ApiError(409, "slug_collision"))).toBe(
      "duplicate_title",
    );
    expect(classifyCollectionUpdateError(new ApiError(404, "not_found"))).toBe("missing");
    expect(classifyCollectionUpdateError(new ApiError(500, "internal"))).toBe("update_failed");
    expect(classifyCollectionUpdateError(new TypeError("fetch failed"))).toBe("update_failed");
  });
});

describe("collectionUpdateFailureMessage", () => {
  it("speaks each arm", () => {
    expect(collectionUpdateFailureMessage("duplicate_title")).toContain("already exists");
    expect(collectionUpdateFailureMessage("missing")).toContain("no longer exists");
    expect(collectionUpdateFailureMessage("update_failed")).toContain("Try again");
  });
});

describe("deleteCollection", () => {
  it("returns the deletion anchor on 200", async () => {
    const body = { collection_id: C1, deleted_at: 42 };
    const result = await deleteCollection(C1, jsonClient(200, body));
    expect(result.deleted_at).toBe(42);
  });

  it("throws a typed ApiError on the no-cascade 409", async () => {
    await expect(
      deleteCollection(C1, jsonClient(409, { error: "has_live_descendants" })),
    ).rejects.toThrow(new ApiError(409, "has_live_descendants"));
  });
});

describe("classifyCollectionDeleteError", () => {
  it("maps 409 to not_empty, 404 to missing, the rest to delete_failed", () => {
    expect(classifyCollectionDeleteError(new ApiError(409, "has_live_descendants"))).toBe(
      "not_empty",
    );
    expect(classifyCollectionDeleteError(new ApiError(404, "not_found"))).toBe("missing");
    expect(classifyCollectionDeleteError(new ApiError(500, "internal"))).toBe("delete_failed");
    expect(classifyCollectionDeleteError(new TypeError("fetch failed"))).toBe("delete_failed");
  });
});

describe("collectionDeleteFailureMessage", () => {
  it("speaks each arm — not_empty is actionable, counts never cross the wire", () => {
    expect(collectionDeleteFailureMessage("not_empty")).toContain("Empty it first");
    expect(collectionDeleteFailureMessage("missing")).toContain("no longer exists");
    expect(collectionDeleteFailureMessage("delete_failed")).toContain("Try again");
  });
});

describe("collectionSpaceLabel", () => {
  const spaces = [{ space_id: "018f0000-0000-7000-8000-00000000aaaa", name: "Engineering" }];

  it("renders the legacy bucket, a bound space's name, or the honest unknown", () => {
    expect(collectionSpaceLabel(null, spaces)).toBe("workspace");
    expect(collectionSpaceLabel("018f0000-0000-7000-8000-00000000aaaa", spaces)).toBe(
      "Engineering",
    );
    expect(collectionSpaceLabel("018f0000-0000-7000-8000-00000000dead", spaces)).toBe(
      "unknown space",
    );
  });
});

describe("collectionDescendantIds (the cycle rail's exclusion set)", () => {
  it("includes the root and every transitive descendant, nothing else", () => {
    const cols = [
      row(C1, "Root", null),
      row(C2, "Child", C1),
      row(C3, "Grandchild", C2),
      row(C4, "Unrelated", null),
    ];
    const subtree = collectionDescendantIds(C1, cols);
    expect([...subtree].sort()).toEqual([C1, C2, C3].sort());
    expect(subtree.has(C4)).toBe(false);
  });

  it("a leaf's subtree is itself; resolution survives child-before-parent wire order", () => {
    expect([...collectionDescendantIds(C3, [row(C3, "Leaf", null)])]).toEqual([C3]);
    // Child rows listed BEFORE their parents still resolve (the sweep loops).
    const shuffled = [row(C3, "Grandchild", C2), row(C2, "Child", C1), row(C1, "Root", null)];
    expect(collectionDescendantIds(C1, shuffled).size).toBe(3);
  });

  it("terminates on a corrupt parent cycle", () => {
    const cycle = [row(C1, "A", C2), row(C2, "B", C1)];
    expect(collectionDescendantIds(C1, cycle).size).toBe(2);
  });
});

describe("parseMoveDestination / destinationBinding", () => {
  const SPACE = "018f0000-0000-7000-8000-00000000aaaa";
  const bound: CollectionSummary = { ...row(C1, "Bound", null), space_id: SPACE };
  const legacy = row(C2, "Legacy", null);

  it("decodes the three select encodings", () => {
    expect(parseMoveDestination("")).toEqual({ kind: "legacy_root" });
    expect(parseMoveDestination(`space:${SPACE}`)).toEqual({
      kind: "space_root",
      space_id: SPACE,
    });
    expect(parseMoveDestination(C1)).toEqual({ kind: "collection", collection_id: C1 });
  });

  it("resolves each destination kind to its bucket", () => {
    const cols = [bound, legacy];
    expect(destinationBinding({ kind: "legacy_root" }, cols)).toBeNull();
    expect(destinationBinding({ kind: "space_root", space_id: SPACE }, cols)).toBe(SPACE);
    expect(destinationBinding({ kind: "collection", collection_id: C1 }, cols)).toBe(SPACE);
    expect(destinationBinding({ kind: "collection", collection_id: C2 }, cols)).toBeNull();
  });
});

describe("moveCollection", () => {
  const MOVED = { collection_id: C1, new_parent_id: null, space_id: null, updated_at: 7 };

  it("returns the move echo on 200", async () => {
    const result = await moveCollection(
      C1,
      { kind: "legacy_root" },
      undefined,
      jsonClient(200, MOVED),
    );
    expect(result.collection_id).toBe(C1);
  });

  it("throws a typed ApiError on the destination slug 409", async () => {
    await expect(
      moveCollection(
        C1,
        { kind: "collection", collection_id: C2 },
        "adopt_baseline",
        jsonClient(409, { error: "slug_collision" }),
      ),
    ).rejects.toThrow(new ApiError(409, "slug_collision"));
  });
});

describe("classifyCollectionMoveError", () => {
  it("maps 409/404/403 to their typed arms, the rest to move_failed", () => {
    expect(classifyCollectionMoveError(new ApiError(409, "slug_collision"))).toBe(
      "destination_clash",
    );
    expect(classifyCollectionMoveError(new ApiError(404, "not_found"))).toBe("target_missing");
    expect(classifyCollectionMoveError(new ApiError(403, "permission_denied"))).toBe("no_access");
    expect(classifyCollectionMoveError(new ApiError(500, "internal"))).toBe("move_failed");
    expect(classifyCollectionMoveError(new TypeError("fetch failed"))).toBe("move_failed");
  });
});

describe("collectionMoveFailureMessage", () => {
  it("speaks each arm — no_access never offers a retry (standing, not luck)", () => {
    expect(collectionMoveFailureMessage("destination_clash")).toContain("already exists");
    expect(collectionMoveFailureMessage("target_missing")).toContain("no longer exists");
    expect(collectionMoveFailureMessage("no_access")).toContain("access");
    expect(collectionMoveFailureMessage("move_failed")).toContain("Try again");
  });
});
