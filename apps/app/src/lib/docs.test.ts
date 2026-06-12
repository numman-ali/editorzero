import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  classifyCreateError,
  classifyRenameError,
  createDoc,
  createFailureMessage,
  DELETE_FAILED_MESSAGE,
  DOC_LIST_QUERY_KEY,
  deleteDoc,
  docAccessModeLabel,
  docListQueryOptions,
  docTagClass,
  fetchDocList,
  formatUpdated,
  publishDoc,
  publishFailureMessage,
  renameDoc,
  renameFailureMessage,
  unpublishDoc,
} from "./docs";

/**
 * Same fake-client pattern as `session.test.ts`: a REAL typed client with an
 * injected fetch returning one canned response — `res.json()` yields the typed
 * union with no `as` anywhere. The canned body stays an untyped literal on
 * purpose (it crosses the wire as JSON; the assertion checks what comes back).
 */
function clientReturning(status: number, body: BodyInit | null): ApiClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
  return createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl });
}

function jsonClient(status: number, body: unknown): ApiClient {
  return clientReturning(status, JSON.stringify(body));
}

const ONE_DOC = {
  docs: [
    {
      id: "018f0000-0000-7000-8000-0000000000d1",
      title: "Hello",
      slug: "hello",
      collection_id: null,
      access_mode: "space",
      published_slug: null,
      published_at: null,
      created_at: 1,
      updated_at: 2,
    },
  ],
};

describe("fetchDocList", () => {
  it("resolves the docs payload on 200", async () => {
    const result = await fetchDocList(jsonClient(200, ONE_DOC));
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0]?.title).toBe("Hello");
  });

  it("throws ApiError with the typed envelope code on a 403", async () => {
    await expect(
      fetchDocList(jsonClient(403, { error: "permission_denied" })),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });

  it("throws an ApiError instance (not a plain Error)", async () => {
    await expect(
      fetchDocList(jsonClient(401, { error: "unauthenticated" })),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("falls back to request_failed for a non-JSON 5xx", async () => {
    await expect(fetchDocList(clientReturning(500, "<html>oops</html>"))).rejects.toMatchObject({
      status: 500,
      code: "request_failed",
    });
  });
});

describe("docListQueryOptions", () => {
  it("binds the stable query key to fetchDocList against the given client", async () => {
    const options = docListQueryOptions(jsonClient(200, ONE_DOC));
    expect(options.queryKey).toEqual(DOC_LIST_QUERY_KEY);
    // Run the binding through real react-query machinery — no direct
    // queryFn invocation (its context parameter is library-internal).
    const result = await new QueryClient().fetchQuery(options);
    expect(result.docs.map((d) => d.slug)).toEqual(["hello"]);
  });
});

const CREATED = {
  doc_id: "018f0000-0000-7000-8000-0000000000d2",
  workspace_id: "018f0000-0000-7000-8000-0000000000aa",
  collection_id: null,
  title: "Drafted",
  slug: "drafted",
  order_key: "a0",
  created_by: "018f0000-0000-7000-8000-0000000000bb",
  access_mode: "space",
  published_slug: null,
  published_at: null,
  seed_blocks: [],
};

describe("createDoc", () => {
  it("resolves the 201 echo (navigation reads doc_id from it)", async () => {
    const created = await createDoc("Drafted", jsonClient(201, CREATED));
    expect(created.doc_id).toBe(CREATED.doc_id);
    expect(created.title).toBe("Drafted");
  });

  it("throws ApiError with the typed envelope code on a 409 slug collision", async () => {
    await expect(
      createDoc("Drafted", jsonClient(409, { error: "slug_collision" })),
    ).rejects.toMatchObject({
      status: 409,
      code: "slug_collision",
    });
  });

  it("throws an ApiError instance on a 400", async () => {
    await expect(
      createDoc("", jsonClient(400, { error: "validation_failed" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("classifyCreateError (409 = unretryable title, everything else retryable)", () => {
  it("maps a 409 ApiError to duplicate_title", () => {
    expect(classifyCreateError(new ApiError(409, "slug_collision"))).toBe("duplicate_title");
  });

  it("maps other ApiErrors to create_failed", () => {
    expect(classifyCreateError(new ApiError(500, "internal"))).toBe("create_failed");
  });

  it("maps non-ApiError throwables (network faults) to create_failed", () => {
    expect(classifyCreateError(new TypeError("fetch failed"))).toBe("create_failed");
  });
});

describe("createFailureMessage", () => {
  it("tells the user to pick a different title on duplicate_title", () => {
    expect(createFailureMessage("duplicate_title")).toContain("already exists");
  });

  it("offers a retry on create_failed", () => {
    expect(createFailureMessage("create_failed")).toContain("Try again");
  });
});

describe("renameDoc", () => {
  const RENAMED = {
    doc_id: "018f0000-0000-7000-8000-0000000000d2",
    title: "Renamed",
    slug: "renamed",
    updated_at: 3,
  };

  it("resolves the 200 echo with the re-derived slug", async () => {
    const renamed = await renameDoc(RENAMED.doc_id, "Renamed", jsonClient(200, RENAMED));
    expect(renamed.title).toBe("Renamed");
    expect(renamed.slug).toBe("renamed");
  });

  it("throws ApiError with the typed envelope code on a 409 slug collision", async () => {
    await expect(
      renameDoc(RENAMED.doc_id, "Taken", jsonClient(409, { error: "slug_collision" })),
    ).rejects.toMatchObject({ status: 409, code: "slug_collision" });
  });

  it("throws an ApiError instance on a 404", async () => {
    await expect(
      renameDoc(RENAMED.doc_id, "Gone", jsonClient(404, { error: "not_found" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("classifyRenameError (same 409 rule as create — sibling slug collision)", () => {
  it("maps a 409 ApiError to duplicate_title", () => {
    expect(classifyRenameError(new ApiError(409, "slug_collision"))).toBe("duplicate_title");
  });

  it("maps other ApiErrors to rename_failed", () => {
    expect(classifyRenameError(new ApiError(500, "internal"))).toBe("rename_failed");
  });

  it("maps non-ApiError throwables (network faults) to rename_failed", () => {
    expect(classifyRenameError(new TypeError("fetch failed"))).toBe("rename_failed");
  });
});

describe("renameFailureMessage", () => {
  it("tells the user to pick a different title on duplicate_title", () => {
    expect(renameFailureMessage("duplicate_title")).toContain("already exists");
  });

  it("offers a retry on rename_failed", () => {
    expect(renameFailureMessage("rename_failed")).toContain("Try again");
  });
});

describe("deleteDoc", () => {
  const DELETED = {
    doc_id: "018f0000-0000-7000-8000-0000000000d2",
    deleted_at: 5,
    render_version: 2,
  };

  it("resolves the 200 echo (soft-delete projection)", async () => {
    const deleted = await deleteDoc(DELETED.doc_id, jsonClient(200, DELETED));
    expect(deleted.deleted_at).toBe(5);
  });

  it("throws ApiError with the typed envelope code on a 404", async () => {
    await expect(
      deleteDoc(DELETED.doc_id, jsonClient(404, { error: "not_found" })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("DELETE_FAILED_MESSAGE offers a retry", () => {
    expect(DELETE_FAILED_MESSAGE).toContain("Try again");
  });
});

describe("publishDoc / unpublishDoc", () => {
  it("publish resolves the 200 echo with the minted slug + timestamp", async () => {
    const body = {
      doc_id: "018f0000-0000-7000-8000-0000000000d2",
      published_slug: "drafted-2",
      published_at: 7,
      render_version: 3,
    };
    const published = await publishDoc(body.doc_id, jsonClient(200, body));
    expect(published.published_slug).toBe("drafted-2");
    expect(published.published_at).toBe(7);
  });

  it("unpublish resolves the cleared pair", async () => {
    const body = {
      doc_id: "018f0000-0000-7000-8000-0000000000d2",
      published_slug: null,
      published_at: null,
      render_version: 4,
    };
    const unpublished = await unpublishDoc(body.doc_id, jsonClient(200, body));
    expect(unpublished.published_slug).toBeNull();
  });

  it("both throw typed ApiErrors on the envelope arms", async () => {
    await expect(
      publishDoc("018f0000-0000-7000-8000-0000000000d2", jsonClient(404, { error: "not_found" })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      unpublishDoc(
        "018f0000-0000-7000-8000-0000000000d2",
        jsonClient(403, { error: "permission_denied" }),
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("publishFailureMessage names the failed direction", () => {
    expect(publishFailureMessage("publish")).toContain("Publish failed");
    expect(publishFailureMessage("unpublish")).toContain("Unpublish failed");
  });
});

describe("docAccessModeLabel (ADR 0040 vocabulary lock)", () => {
  it('renders the wire value "space" as "Space"', () => {
    expect(docAccessModeLabel("space")).toBe("Space");
  });

  it("passes private through", () => {
    expect(docAccessModeLabel("private")).toBe("private");
  });
});

describe("docTagClass (publish dimension, orthogonal to access_mode)", () => {
  it("reserves the published-green pair for a published doc", () => {
    expect(docTagClass(1_700_000_000_000)).toBe("status-tag st-pub");
  });

  it("keeps the base outline for an unpublished doc", () => {
    expect(docTagClass(null)).toBe("status-tag");
  });
});

describe("formatUpdated", () => {
  it("renders a deterministic UTC date", () => {
    expect(formatUpdated(Date.UTC(2026, 5, 11, 23, 59, 59))).toBe("2026-06-11");
    expect(formatUpdated(0)).toBe("1970-01-01");
  });
});
