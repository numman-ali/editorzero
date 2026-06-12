import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  fetchSpace,
  fetchSpaceList,
  SPACE_LIST_QUERY_KEY,
  spaceKindLabel,
  spaceListQueryOptions,
  spaceMetaLine,
  spaceQueryKey,
  spaceQueryOptions,
} from "./spaces";

/**
 * Same fake-client pattern as `docs.test.ts`: a REAL typed client with an
 * injected fetch returning one canned response — `res.json()` yields the
 * typed union with no `as` anywhere.
 */
function clientReturning(status: number, body: BodyInit | null): ApiClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
  return createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl });
}

function jsonClient(status: number, body: unknown): ApiClient {
  return clientReturning(status, JSON.stringify(body));
}

const TWO_SPACES = {
  spaces: [
    {
      space_id: "018f0000-0000-7000-8000-00000000005a",
      workspace_id: "018f0000-0000-7000-8000-0000000000aa",
      kind: "team",
      type: "open",
      owner_user_id: null,
      name: "Engineering",
      slug: "engineering",
      baseline_access: "view",
      created_by: "018f0000-0000-7000-8000-0000000000cc",
      created_at: 1,
      updated_at: 2,
      deleted_at: null,
    },
    {
      space_id: "018f0000-0000-7000-8000-00000000005b",
      workspace_id: "018f0000-0000-7000-8000-0000000000aa",
      kind: "personal",
      type: "private",
      owner_user_id: "018f0000-0000-7000-8000-0000000000cc",
      name: "Personal",
      slug: "personal",
      baseline_access: "view",
      created_by: "018f0000-0000-7000-8000-0000000000cc",
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    },
  ],
};

describe("fetchSpaceList", () => {
  it("resolves the spaces payload on 200", async () => {
    const result = await fetchSpaceList(jsonClient(200, TWO_SPACES));
    expect(result.spaces).toHaveLength(2);
    expect(result.spaces[0]?.name).toBe("Engineering");
  });

  it("throws ApiError with the typed envelope code on a 403", async () => {
    await expect(
      fetchSpaceList(jsonClient(403, { error: "permission_denied" })),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });

  it("throws an ApiError instance (not a plain Error)", async () => {
    await expect(
      fetchSpaceList(jsonClient(401, { error: "unauthenticated" })),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("falls back to request_failed for a non-JSON 5xx", async () => {
    await expect(fetchSpaceList(clientReturning(500, "<html>oops</html>"))).rejects.toMatchObject({
      status: 500,
      code: "request_failed",
    });
  });
});

describe("spaceListQueryOptions", () => {
  it("binds the stable query key to fetchSpaceList against the given client", async () => {
    const options = spaceListQueryOptions(jsonClient(200, TWO_SPACES));
    expect(options.queryKey).toEqual(SPACE_LIST_QUERY_KEY);
    // Run the binding through real react-query machinery — no direct
    // queryFn invocation (its context parameter is library-internal).
    const result = await new QueryClient().fetchQuery(options);
    expect(result.spaces.map((s) => s.slug)).toEqual(["engineering", "personal"]);
  });
});

const ONE_SPACE = TWO_SPACES.spaces[0];

describe("fetchSpace", () => {
  it("resolves the bare row on 200 (no wrapper)", async () => {
    const space = await fetchSpace(
      "018f0000-0000-7000-8000-00000000005a",
      jsonClient(200, ONE_SPACE),
    );
    expect(space.name).toBe("Engineering");
    expect(space.baseline_access).toBe("view");
  });

  it("throws ApiError with the typed envelope code on a 404 (invisible/trashed)", async () => {
    await expect(
      fetchSpace("018f0000-0000-7000-8000-00000000005a", jsonClient(404, { error: "not_found" })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("throws an ApiError instance on a 403", async () => {
    await expect(
      fetchSpace(
        "018f0000-0000-7000-8000-00000000005a",
        jsonClient(403, { error: "permission_denied" }),
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("spaceQueryOptions", () => {
  it("keys the cache per space id and binds fetchSpace against the given client", async () => {
    const options = spaceQueryOptions(
      "018f0000-0000-7000-8000-00000000005a",
      jsonClient(200, ONE_SPACE),
    );
    expect(options.queryKey).toEqual(spaceQueryKey("018f0000-0000-7000-8000-00000000005a"));
    expect(spaceQueryKey("a")).not.toEqual(spaceQueryKey("b"));
    const space = await new QueryClient().fetchQuery(options);
    expect(space.slug).toBe("engineering");
  });
});

describe("spaceKindLabel (ADR 0040 vocabulary lock)", () => {
  it('renders the wire value "personal" as "Personal"', () => {
    expect(spaceKindLabel("personal")).toBe("Personal");
  });

  it('renders the wire value "team" as "Team"', () => {
    expect(spaceKindLabel("team")).toBe("Team");
  });
});

describe("spaceMetaLine", () => {
  it("joins type and baseline role in wire vocabulary", () => {
    expect(spaceMetaLine({ type: "open", baseline_access: "edit" })).toBe("open · baseline edit");
  });

  it("renders the row truth even where the baseline is inert (private)", () => {
    expect(spaceMetaLine({ type: "private", baseline_access: "view" })).toBe(
      "private · baseline view",
    );
  });
});
