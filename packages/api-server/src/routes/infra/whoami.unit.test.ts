/**
 * Per-route unit test for `/infra/whoami` (ADR 0029 code-first shape).
 * Mounts only this route's `Hono<ApiEnv>` sub-app at `/infra` on a fresh
 * trunk with a fake principal-middleware that injects a canned
 * `Principal` onto `c.var`. The real principal middleware's behaviour is
 * exercised in `middleware/principal.unit.test.ts`; the resolver's
 * behaviour in `@editorzero/auth`'s integration test; the full chain in
 * `composition/auth-chain.integration.test.ts`. This file pins only the
 * handler's projection shape (user vs agent branch, null token/session
 * fields, optional `acting_as`).
 */

import { AgentId, SessionId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import type { Scope } from "@editorzero/scopes";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { whoami } from "./whoami";

function mountWithPrincipal(principal: Principal) {
  const app = new Hono<ApiEnv>();
  app.use("/infra/whoami", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  return app.route("/infra", whoami);
}

const USER_ID = UserId("018f0000-0000-7000-8000-0000000000a1");
const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-0000000000b1");
const SESSION_ID = SessionId("018f0000-0000-7000-8000-0000000000d1");
const TOKEN_ID = TokenId("018f0000-0000-7000-8000-0000000000e1");
const AGENT_ID = AgentId("018f0000-0000-7000-8000-0000000000c1");

describe("GET /infra/whoami", () => {
  it("returns the user-branch projection for a UserPrincipal with a session", async () => {
    const app = mountWithPrincipal({
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      roles: ["owner"],
      session_id: SESSION_ID,
      token_id: null,
    });
    const res = await app.request("/infra/whoami", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      roles: ["owner"],
      session_id: SESSION_ID,
      token_id: null,
    });
  });

  it("returns the user-branch projection for a UserPrincipal with a bearer token (token_id non-null, session_id null)", async () => {
    // Exercises the PAT branch: `session_id` null because the credential
    // was a bearer, not a cookie; `token_id` set to the api-key row.
    const app = mountWithPrincipal({
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      roles: ["admin", "member"],
      session_id: null,
      token_id: TOKEN_ID,
    });
    const res = await app.request("/infra/whoami", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      roles: ["admin", "member"],
      session_id: null,
      token_id: TOKEN_ID,
    });
  });

  it("returns the agent-branch projection for an api-key AgentPrincipal without acting_as", async () => {
    const app = mountWithPrincipal({
      kind: "agent",
      id: AGENT_ID,
      workspace_id: WORKSPACE_ID,
      owner_user_id: USER_ID,
      scopes: ["doc:read", "doc:write"] as readonly Scope[],
      token_id: TOKEN_ID,
      token_kind: "api-key",
    });
    const res = await app.request("/infra/whoami", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      kind: "agent",
      id: AGENT_ID,
      workspace_id: WORKSPACE_ID,
      owner_user_id: USER_ID,
      scopes: ["doc:read", "doc:write"],
      token_id: TOKEN_ID,
      token_kind: "api-key",
    });
    // `acting_as` is not emitted when undefined (discriminated-union
    // schema permits omission; the CLI + Web UI rely on presence to
    // decide whether to render the delegator).
    expect(body).not.toHaveProperty("acting_as");
  });

  it("includes acting_as in the agent-branch projection when the delegated token carries it", async () => {
    const app = mountWithPrincipal({
      kind: "agent",
      id: AGENT_ID,
      workspace_id: WORKSPACE_ID,
      owner_user_id: null,
      scopes: ["doc:read"] as readonly Scope[],
      token_id: TOKEN_ID,
      token_kind: "agent-auth",
      acting_as: USER_ID,
    });
    const res = await app.request("/infra/whoami", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      kind: "agent",
      token_kind: "agent-auth",
      acting_as: USER_ID,
    });
  });
});
