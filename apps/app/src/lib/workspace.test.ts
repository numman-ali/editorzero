import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  fetchWorkspaceGet,
  WORKSPACE_GET_QUERY_KEY,
  workspaceGetQueryOptions,
  workspaceMonogram,
} from "./workspace";

/** Same fake-client pattern as `docs.test.ts`/`spaces.test.ts`. */
function clientReturning(status: number, body: BodyInit | null): ApiClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
  return createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl });
}

function jsonClient(status: number, body: unknown): ApiClient {
  return clientReturning(status, JSON.stringify(body));
}

const WORKSPACE = {
  workspace_id: "018f0000-0000-7000-8000-0000000000aa",
  slug: "founder-x7k2",
  name: "founder's workspace",
  trash_retention_days: 30,
  created_by: "018f0000-0000-7000-8000-0000000000cc",
  created_at: 1,
  settings: {},
};

describe("fetchWorkspaceGet", () => {
  it("resolves the workspace payload on 200", async () => {
    const result = await fetchWorkspaceGet(jsonClient(200, WORKSPACE));
    expect(result.name).toBe("founder's workspace");
    expect(result.slug).toBe("founder-x7k2");
  });

  it("throws ApiError with the typed envelope code on a 401", async () => {
    await expect(
      fetchWorkspaceGet(jsonClient(401, { error: "unauthenticated" })),
    ).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("falls back to request_failed for a non-JSON 5xx", async () => {
    await expect(
      fetchWorkspaceGet(clientReturning(500, "<html>oops</html>")),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      fetchWorkspaceGet(clientReturning(500, "<html>oops</html>")),
    ).rejects.toMatchObject({ status: 500, code: "request_failed" });
  });
});

describe("workspaceGetQueryOptions", () => {
  it("binds the stable query key to fetchWorkspaceGet against the given client", async () => {
    const options = workspaceGetQueryOptions(jsonClient(200, WORKSPACE));
    expect(options.queryKey).toEqual(WORKSPACE_GET_QUERY_KEY);
    const result = await new QueryClient().fetchQuery(options);
    expect(result.workspace_id).toBe(WORKSPACE.workspace_id);
  });
});

describe("workspaceMonogram", () => {
  it("uppercases the first character of the name", () => {
    expect(workspaceMonogram("founder's workspace")).toBe("F");
  });

  it("trims leading whitespace before picking the letter", () => {
    expect(workspaceMonogram("  acme")).toBe("A");
  });

  it("falls back to ? on an all-whitespace name (totality, not an expected state)", () => {
    expect(workspaceMonogram("   ")).toBe("?");
  });
});
