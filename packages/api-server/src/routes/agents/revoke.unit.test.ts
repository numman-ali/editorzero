/**
 * Minimal-app test for `POST /agents/revoke/:agent_id` (ADR 0021
 * §Per-route test posture; ADR 0029 code-first shape). Param-only
 * input (the `space.archive` pattern); the 200 echo is the minimal
 * terminal shape `{agent_id, revoked_at}`. Terminal re-revoke
 * semantics live in the capability suite.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { revoke } from "./revoke";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["admin"],
  session_id: null,
  token_id: null,
};

const VALID_AGENT_ID = "018f0000-0000-7000-8000-0000000000a7";

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
  app.route("/agents", revoke);
  return app;
}

describe("POST /agents/revoke/:agent_id", () => {
  it("dispatches agent.revoke with path-param agent_id, returns the minimal terminal echo", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return { agent_id: VALID_AGENT_ID, revoked_at: 1700000000000 };
    });

    const res = await app.request(`/agents/revoke/${VALID_AGENT_ID}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agent_id: VALID_AGENT_ID, revoked_at: 1700000000000 });

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("agent.revoke"));
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

    const res = await app.request("/agents/revoke/not-a-uuid", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
