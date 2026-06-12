import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { describe, expect, it } from "vitest";

import {
  fetchGrantPage,
  grantGrantedByLabel,
  grantGuestMarker,
  grantListInfiniteOptions,
  grantListQueryKey,
  grantSubjectLabel,
  PERMISSION_PAGE_SIZE,
  type PermissionList,
} from "./permissions";

/**
 * Same fake-client pattern as `audit.test.ts`: a REAL typed client with
 * an injected fetch returning one canned response, the capturing variant
 * recording request URLs — `fetchGrantPage`'s cursor handling is QUERY
 * construction (`.strict()` wire schema: the first page must OMIT the
 * cursor keys, not send empties), so the URL is the behavior under test.
 */
function capturingClient(status: number, body: unknown): { client: ApiClient; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { client: createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl }), urls };
}

const DOC_ID = "018f0000-0000-7000-8000-0000000000d1";
const GRANT = {
  grant_id: "01970000-0000-7000-8000-00000000aaaa",
  workspace_id: "018f0000-0000-7000-8000-0000000000aa",
  resource_kind: "doc",
  resource_id: DOC_ID,
  subject_kind: "agent",
  subject_id: "01970000-0000-7000-8000-00000000beef",
  role: "view",
  is_guest: 0,
  created_by: "user-000000000000000001",
  created_at: Date.UTC(2026, 5, 12, 4, 0, 0),
};

const CURSOR = { before_created_at: GRANT.created_at, before_grant_id: GRANT.grant_id };
const PAGE = { grants: [GRANT], next_cursor: CURSOR };
const LAST_PAGE = { grants: [GRANT], next_cursor: null };

// Typed pages for exercising getNextPageParam directly: its parameter is
// the full derived PermissionList (branded ids and all) — empty `grants`
// keeps the fixture honest without restating a wire row in branded form.
const TYPED_PAGE: PermissionList = { grants: [], next_cursor: CURSOR };
const TYPED_LAST: PermissionList = { grants: [], next_cursor: null };

describe("fetchGrantPage", () => {
  it("returns the typed page on 200 and asks for the head with resource + limit only", async () => {
    const { client, urls } = capturingClient(200, PAGE);
    const result = await fetchGrantPage("doc", DOC_ID, null, client);
    expect(result.grants[0]?.role).toBe("view");
    expect(result.next_cursor).toEqual(CURSOR);
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/permissions/list");
    expect(url.searchParams.get("resource_kind")).toBe("doc");
    expect(url.searchParams.get("resource_id")).toBe(DOC_ID);
    expect(url.searchParams.get("limit")).toBe(String(PERMISSION_PAGE_SIZE));
    expect(url.searchParams.has("before_created_at")).toBe(false);
    expect(url.searchParams.has("before_grant_id")).toBe(false);
  });

  it("sends both cursor keys when paging past the head", async () => {
    const { client, urls } = capturingClient(200, LAST_PAGE);
    await fetchGrantPage("doc", DOC_ID, CURSOR, client);
    const url = new URL(urls[0] ?? "");
    expect(url.searchParams.get("before_created_at")).toBe(String(CURSOR.before_created_at));
    expect(url.searchParams.get("before_grant_id")).toBe(CURSOR.before_grant_id);
  });

  it("throws a typed ApiError carrying the wire code on failure", async () => {
    const { client } = capturingClient(404, { error: "not_found" });
    await expect(fetchGrantPage("doc", DOC_ID, null, client)).rejects.toThrowError(ApiError);
  });
});

describe("grantListInfiniteOptions", () => {
  it("keys by kind + resource and chains the wire cursor verbatim", () => {
    const options = grantListInfiniteOptions("doc", DOC_ID);
    expect(options.queryKey).toEqual(["permission.list", "doc", DOC_ID]);
    expect(options.initialPageParam).toBeNull();
    expect(options.getNextPageParam(TYPED_PAGE, [TYPED_PAGE], null, [null])).toEqual(CURSOR);
    expect(options.getNextPageParam(TYPED_LAST, [TYPED_LAST], null, [null])).toBeNull();
  });

  it("query keys for the two resource kinds never collide", () => {
    expect(grantListQueryKey("doc", DOC_ID)).not.toEqual(grantListQueryKey("space", DOC_ID));
  });
});

describe("display labels", () => {
  it("labels subjects as kind + abbreviated id (the audit shape)", () => {
    expect(grantSubjectLabel({ subject_kind: "agent", subject_id: GRANT.subject_id })).toBe(
      "agent 01970000…",
    );
    expect(grantSubjectLabel({ subject_kind: "user", subject_id: "u-1" })).toBe("user u-1");
  });

  it("attributes the grantor as a user id", () => {
    expect(grantGrantedByLabel({ created_by: GRANT.created_by })).toBe("user user-000…");
  });

  it("marks guest edges and only guest edges", () => {
    expect(grantGuestMarker({ is_guest: 1 })).toBe("guest");
    expect(grantGuestMarker({ is_guest: 0 })).toBeNull();
  });
});
