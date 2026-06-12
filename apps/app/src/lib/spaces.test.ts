import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  archiveSpace,
  classifySpaceArchiveError,
  classifySpaceCreateError,
  classifySpaceUpdateError,
  createSpace,
  diffSpacePatch,
  fetchSpace,
  fetchSpaceList,
  SPACE_BASELINE_ROLES,
  SPACE_LIST_QUERY_KEY,
  SPACE_TYPES,
  spaceArchiveFailureMessage,
  spaceCreateFailureMessage,
  spaceKindLabel,
  spaceListQueryOptions,
  spaceMetaLine,
  spaceQueryKey,
  spaceQueryOptions,
  spaceUpdateFailureMessage,
  updateSpace,
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

describe("createSpace", () => {
  it("resolves the full row echo on 200 (navigation reads space_id)", async () => {
    const created = await createSpace("Design", "closed", jsonClient(200, ONE_SPACE));
    expect(created.space_id).toBe(ONE_SPACE?.space_id);
    expect(created.kind).toBe("team");
  });

  it("throws ApiError with the typed envelope code on a 409 slug collision", async () => {
    await expect(
      createSpace("Engineering", "open", jsonClient(409, { error: "slug_collision" })),
    ).rejects.toMatchObject({ status: 409, code: "slug_collision" });
  });

  it("throws an ApiError instance on a 400", async () => {
    await expect(
      createSpace("", "open", jsonClient(400, { error: "validation_failed" })),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("SPACE_TYPES carries the wire vocabulary in declaration order", () => {
    expect(SPACE_TYPES).toEqual(["open", "closed", "private"]);
  });
});

describe("classifySpaceCreateError (the form-409 rule, workspace-level slugs)", () => {
  it("maps a 409 ApiError to duplicate_name", () => {
    expect(classifySpaceCreateError(new ApiError(409, "slug_collision"))).toBe("duplicate_name");
  });

  it("maps other ApiErrors to create_failed", () => {
    expect(classifySpaceCreateError(new ApiError(500, "internal"))).toBe("create_failed");
  });

  it("maps non-ApiError throwables (network faults) to create_failed", () => {
    expect(classifySpaceCreateError(new TypeError("fetch failed"))).toBe("create_failed");
  });
});

describe("spaceCreateFailureMessage", () => {
  it("tells the user to pick a different name on duplicate_name", () => {
    expect(spaceCreateFailureMessage("duplicate_name")).toContain("already exists");
  });

  it("offers a retry on create_failed", () => {
    expect(spaceCreateFailureMessage("create_failed")).toContain("Try again");
  });
});

const CURRENT: Parameters<typeof diffSpacePatch>[0] = {
  name: "Design",
  slug: "design",
  type: "closed",
  baseline_access: "view",
};

describe("diffSpacePatch (only changed fields travel)", () => {
  it("returns null when nothing changed (the form closes without a wire call)", () => {
    expect(
      diffSpacePatch(CURRENT, {
        name: "Design",
        slug: "design",
        space_type: "closed",
        baseline_access: "view",
      }),
    ).toBeNull();
  });

  it("trims and diffs name + slug; unchanged fields stay off the wire", () => {
    expect(diffSpacePatch(CURRENT, { name: "  Design Studio  ", slug: "design" })).toEqual({
      name: "Design Studio",
    });
  });

  it("carries type/baseline only when the draft offers them AND they changed", () => {
    expect(
      diffSpacePatch(CURRENT, {
        name: "Design",
        slug: "design-studio",
        space_type: "open",
        baseline_access: "edit",
      }),
    ).toEqual({ slug: "design-studio", space_type: "open", baseline_access: "edit" });
    // The personal-space form never offers the selects — the draft has
    // no type/baseline keys, so the patch cannot carry the pinned fields.
    expect(diffSpacePatch(CURRENT, { name: "Drafts", slug: "design" })).toEqual({
      name: "Drafts",
    });
  });

  it("ignores blanked-out fields (an empty input is no instruction)", () => {
    expect(diffSpacePatch(CURRENT, { name: "  ", slug: "" })).toBeNull();
  });

  it("SPACE_BASELINE_ROLES mirrors the wire vocabulary in declaration order", () => {
    expect(SPACE_BASELINE_ROLES).toEqual(["edit", "comment", "view"]);
  });
});

describe("updateSpace", () => {
  it("resolves the patched row echo on 200", async () => {
    const updated = await updateSpace(
      "018f0000-0000-7000-8000-00000000005a",
      { name: "Design Studio" },
      jsonClient(200, { ...ONE_SPACE, name: "Design Studio" }),
    );
    expect(updated.name).toBe("Design Studio");
  });

  it("throws ApiError with the typed envelope code on a 409 slug collision", async () => {
    await expect(
      updateSpace(
        "018f0000-0000-7000-8000-00000000005a",
        { slug: "personal" },
        jsonClient(409, { error: "slug_collision" }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "slug_collision" });
  });

  it("throws an ApiError instance on a 400 (pinned personal fields)", async () => {
    await expect(
      updateSpace(
        "018f0000-0000-7000-8000-00000000005b",
        { space_type: "open" },
        jsonClient(400, { error: "validation_failed" }),
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("classifySpaceUpdateError + spaceUpdateFailureMessage", () => {
  it("maps a 409 to duplicate_slug with the pick-a-different-slug line", () => {
    expect(classifySpaceUpdateError(new ApiError(409, "slug_collision"))).toBe("duplicate_slug");
    expect(spaceUpdateFailureMessage("duplicate_slug")).toContain("already exists");
  });

  it("maps everything else to the generic retry arm", () => {
    expect(classifySpaceUpdateError(new ApiError(500, "internal"))).toBe("update_failed");
    expect(classifySpaceUpdateError(new TypeError("fetch failed"))).toBe("update_failed");
    expect(spaceUpdateFailureMessage("update_failed")).toContain("Try again");
  });
});

describe("archiveSpace", () => {
  it("resolves the soft-delete echo on 200", async () => {
    const archived = await archiveSpace(
      "018f0000-0000-7000-8000-00000000005a",
      jsonClient(200, { space_id: "018f0000-0000-7000-8000-00000000005a", deleted_at: 9 }),
    );
    expect(archived.deleted_at).toBe(9);
  });

  it("throws ApiError with the typed envelope code on the 409 descendants refusal", async () => {
    await expect(
      archiveSpace(
        "018f0000-0000-7000-8000-00000000005a",
        jsonClient(409, { error: "has_live_descendants" }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "has_live_descendants" });
  });

  it("throws an ApiError instance on a 404 (already archived — trash-invisible)", async () => {
    await expect(
      archiveSpace("018f0000-0000-7000-8000-00000000005a", jsonClient(404, { error: "not_found" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("classifySpaceArchiveError + spaceArchiveFailureMessage", () => {
  it("maps the 409 to not_empty with the actionable empty-it-first line", () => {
    expect(classifySpaceArchiveError(new ApiError(409, "has_live_descendants"))).toBe("not_empty");
    expect(spaceArchiveFailureMessage("not_empty")).toContain("Empty it first");
  });

  it("maps everything else to the generic retry arm", () => {
    expect(classifySpaceArchiveError(new ApiError(500, "internal"))).toBe("archive_failed");
    expect(classifySpaceArchiveError(new TypeError("fetch failed"))).toBe("archive_failed");
    expect(spaceArchiveFailureMessage("archive_failed")).toContain("Try again");
  });
});
