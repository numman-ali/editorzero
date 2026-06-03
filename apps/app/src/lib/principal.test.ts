import { createHttpClient } from "@editorzero/api-client";
import { describe, expect, it } from "vitest";

import { describePrincipal } from "./principal";
import { fetchSession, type WhoamiSession } from "./session";

/**
 * Mint a real, branded `WhoamiSession` by round-tripping a canned body through
 * the typed client (the same cast-free pattern as `session.test.ts`): the
 * branded id fields are compile-time only, so `res.json()` yields the union
 * with no `as`. Lets `describePrincipal` be tested against the true SSOT type
 * rather than a hand-rebuilt shape that could drift.
 */
async function sessionFrom(body: unknown): Promise<WhoamiSession> {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return fetchSession(createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl }));
}

describe("describePrincipal", () => {
  it("describes a user by its roles (square monogram)", async () => {
    const view = describePrincipal(
      await sessionFrom({
        kind: "user",
        id: "user_x",
        workspace_id: "ws_x",
        roles: ["owner", "editor"],
        session_id: "sess_x",
        token_id: null,
      }),
    );
    expect(view).toEqual({
      kind: "user",
      monogram: "U",
      label: "User",
      detail: "OWNER · EDITOR",
    });
  });

  it("falls back to 'no roles' for a roleless user", async () => {
    const view = describePrincipal(
      await sessionFrom({
        kind: "user",
        id: "user_x",
        workspace_id: "ws_x",
        roles: [],
        session_id: "sess_x",
        token_id: null,
      }),
    );
    expect(view.detail).toBe("no roles");
  });

  it("describes an agent by token kind + a pluralised scope count (notched monogram)", async () => {
    const view = describePrincipal(
      await sessionFrom({
        kind: "agent",
        id: "agent_x",
        workspace_id: "ws_x",
        owner_user_id: "user_x",
        scopes: ["doc:read", "doc:write", "collection:read"],
        token_id: "tok_x",
        token_kind: "api-key",
      }),
    );
    expect(view).toEqual({
      kind: "agent",
      monogram: "A",
      label: "Agent",
      detail: "API-KEY · 3 scopes",
    });
  });

  it("uses the singular 'scope' for a single-scope agent", async () => {
    const view = describePrincipal(
      await sessionFrom({
        kind: "agent",
        id: "agent_x",
        workspace_id: "ws_x",
        owner_user_id: "user_x",
        scopes: ["doc:read"],
        token_id: "tok_x",
        token_kind: "api-key",
      }),
    );
    expect(view.detail).toBe("API-KEY · 1 scope");
  });
});
