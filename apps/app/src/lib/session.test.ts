import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { describe, expect, it } from "vitest";

import { fetchSession, SESSION_QUERY_KEY, useSession, type WhoamiSession } from "./session";

/**
 * Build a real typed client whose injected fetch returns one canned response,
 * so `res.json()` yields the typed union with NO `as` on the body. The baseUrl
 * is irrelevant — the fake fetch ignores the URL — so a concrete one is used to
 * sidestep relative-URL construction under Node (the production singleton uses
 * `""` for same-origin; that path is e2e-covered).
 */
function clientReturning(status: number, body: BodyInit | null): ApiClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
  return createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl });
}

function jsonClient(status: number, body: unknown): ApiClient {
  return clientReturning(status, JSON.stringify(body));
}

describe("fetchSession", () => {
  it("resolves a 200 user principal", async () => {
    const session = await fetchSession(
      jsonClient(200, {
        kind: "user",
        id: "user_x",
        workspace_id: "ws_x",
        roles: ["owner"],
        session_id: "sess_x",
        token_id: null,
      }),
    );
    expect(session.kind).toBe("user");
  });

  it("resolves a 200 agent principal (the second union arm)", async () => {
    const session = await fetchSession(
      jsonClient(200, {
        kind: "agent",
        id: "agent_x",
        workspace_id: "ws_x",
        owner_user_id: "user_x",
        scopes: ["doc:read"],
        token_id: "tok_x",
        token_kind: "api-key",
      }),
    );
    expect(session.kind).toBe("agent");
  });

  it("throws ApiError(401, 'unauthenticated') for the middleware 401 envelope", async () => {
    await expect(fetchSession(jsonClient(401, { error: "unauthenticated" }))).rejects.toMatchObject(
      { status: 401, code: "unauthenticated" },
    );
  });

  it("throws ApiError(403, 'permission_denied') from a typed capability envelope", async () => {
    await expect(
      fetchSession(jsonClient(403, { error: "permission_denied" })),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });

  it("rejects with an ApiError instance, not a plain Error", async () => {
    await expect(fetchSession(jsonClient(404, { error: "not_found" }))).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it("falls back to 'request_failed' when json() throws (non-JSON 5xx)", async () => {
    await expect(fetchSession(clientReturning(500, "<html>oops</html>"))).rejects.toMatchObject({
      status: 500,
      code: "request_failed",
    });
  });

  it("falls back to 'unauthenticated' when json() throws on a 401", async () => {
    await expect(fetchSession(clientReturning(401, "<html>nope</html>"))).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
  });

  it("falls back when the JSON body has no error field", async () => {
    await expect(fetchSession(jsonClient(500, { detail: "boom" }))).rejects.toMatchObject({
      status: 500,
      code: "request_failed",
    });
  });

  it("falls back when the error field is not a string", async () => {
    await expect(fetchSession(jsonClient(500, { error: 123 }))).rejects.toMatchObject({
      status: 500,
      code: "request_failed",
    });
  });
});

describe("session query wiring", () => {
  it("exposes a stable query key and the useSession hook", () => {
    expect(SESSION_QUERY_KEY).toEqual(["session"]);
    expect(typeof useSession).toBe("function");
  });

  it("keeps the principal id branded (not `any`) so identity stays type-safe", () => {
    // Compile-time guard (review finding): apps/app has no source-level
    // `@editorzero/ids` import — the brand reaches `WhoamiSession` only via the
    // client type's transitive `import("@editorzero/ids")`. If that dependency
    // is pruned, TS silently degrades `id` to `any`. This errors under
    // `tsc -p tsconfig.test.json` if the brand regresses to `any` (IsAny<any>
    // collapses the annotation to `never`, which `true` cannot satisfy).
    type IsAny<T> = 0 extends 1 & T ? true : false;
    type UserArm = Extract<WhoamiSession, { kind: "user" }>;
    const idIsBranded: IsAny<UserArm["id"]> extends true ? never : true = true;
    expect(idIsBranded).toBe(true);
  });
});
