import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  DOC_LIST_QUERY_KEY,
  docAccessModeLabel,
  docListQueryOptions,
  docTagClass,
  fetchDocList,
  formatUpdated,
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
