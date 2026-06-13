/**
 * Minimal-app test for `GET /agents/token_list/:agent_id` (ADR 0021
 * §Per-route test posture; ADR 0029 code-first shape). P2 param
 * variant. The output shape structurally excludes `token_hash` — the
 * fixture pins the displayable row exactly as the schema admits it.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { tokenList } from "./token_list";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

const VALID_AGENT_ID = "018f0000-0000-7000-8000-0000000000a7";

const TOKEN_ROW = {
  token_id: "018f0000-0000-7000-8000-0000000000c3",
  workspace_id: TEST_PRINCIPAL.workspace_id,
  agent_id: VALID_AGENT_ID,
  token_prefix: "ez_agent_abc",
  last4: "wxyz",
  scopes: ["workspace:read"],
  tier: "read-only",
  created_by: TEST_PRINCIPAL.id,
  created_at: 1,
  expires_at: null,
  revoked_at: null,
};

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new Hono<ApiEnv>();
  const fakeDispatcher = {
    dispatch,
    // biome-ignore lint/suspicious/noExplicitAny: `deps` is not read by the route.
    deps: {} as any,
  } as Dispatcher;
  app.use("*", async (c, next) => {
    c.set("principal", TEST_PRINCIPAL);
    c.set("dispatcher", fakeDispatcher);
    await next();
  });
  app.route("/agents", tokenList);
  return app;
}

describe("GET /agents/token_list/:agent_id", () => {
  it("dispatches agent.token_list with path-param agent_id, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return { tokens: [TOKEN_ROW] };
    });

    const res = await app.request(`/agents/token_list/${VALID_AGENT_ID}`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokens: [TOKEN_ROW] });

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("agent.token_list"));
    expect(captured?.input).toEqual({ agent_id: VALID_AGENT_ID });
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("non-UUID agent_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const res = await app.request("/agents/token_list/not-a-uuid", { method: "GET" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
