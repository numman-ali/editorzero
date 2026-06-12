import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  classifyWorkspaceUpdateError,
  diffWorkspacePatch,
  fetchWorkspaceGet,
  updateWorkspace,
  WORKSPACE_GET_QUERY_KEY,
  workspaceGetQueryOptions,
  workspaceMonogram,
  workspaceUpdateFailureMessage,
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

const CURRENT = { name: "founder's workspace", trash_retention_days: 30 };

describe("diffWorkspacePatch (only changed fields travel)", () => {
  it("returns null when nothing changed", () => {
    expect(
      diffWorkspacePatch(CURRENT, { name: "founder's workspace", trash_retention_days: 30 }),
    ).toBeNull();
  });

  it("trims + diffs the name; carries a changed retention", () => {
    expect(
      diffWorkspacePatch(CURRENT, { name: "  Mission Control ", trash_retention_days: 14 }),
    ).toEqual({ name: "Mission Control", trash_retention_days: 14 });
  });

  it("a blank name or NaN retention is no instruction", () => {
    expect(
      diffWorkspacePatch(CURRENT, { name: "  ", trash_retention_days: Number.NaN }),
    ).toBeNull();
    expect(
      diffWorkspacePatch(CURRENT, {
        name: "founder's workspace",
        trash_retention_days: Number.NaN,
      }),
    ).toBeNull();
  });
});

describe("updateWorkspace", () => {
  it("resolves the patched echo on 200", async () => {
    const updated = await updateWorkspace(
      { name: "Mission Control" },
      jsonClient(200, {
        workspace_id: "018f0000-0000-7000-8000-0000000000aa",
        slug: "founder-1a2b",
        name: "Mission Control",
        trash_retention_days: 30,
      }),
    );
    expect(updated.name).toBe("Mission Control");
  });

  it("throws ApiError with the typed envelope code on a 403 (role-gated)", async () => {
    await expect(
      updateWorkspace({ name: "X" }, jsonClient(403, { error: "permission_denied" })),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });

  it("throws an ApiError instance on a 400 (retention out of bounds)", async () => {
    await expect(
      updateWorkspace({ trash_retention_days: 3 }, jsonClient(400, { error: "validation_failed" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("classifyWorkspaceUpdateError + workspaceUpdateFailureMessage", () => {
  it("maps a 403 to not_allowed with the role-honest line (no false retry)", () => {
    expect(classifyWorkspaceUpdateError(new ApiError(403, "permission_denied"))).toBe(
      "not_allowed",
    );
    expect(workspaceUpdateFailureMessage("not_allowed")).toContain("owners and admins");
  });

  it("maps everything else to the generic retry arm", () => {
    expect(classifyWorkspaceUpdateError(new ApiError(500, "internal"))).toBe("update_failed");
    expect(classifyWorkspaceUpdateError(new TypeError("fetch failed"))).toBe("update_failed");
    expect(workspaceUpdateFailureMessage("update_failed")).toContain("Try again");
  });
});
