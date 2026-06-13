/**
 * Minimal-app test for `POST /agents/update/:agent_id` (ADR 0021
 * §Per-route test posture; ADR 0029 code-first shape). P3 split — the
 * param carries `agent_id`, the body carries `{name}`, the route
 * merges both halves into the capability input. Terminal-revocation
 * and collision semantics live in the capability suite.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { update } from "./update";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["admin"],
  session_id: null,
  token_id: null,
};

const VALID_AGENT_ID = "018f0000-0000-7000-8000-0000000000a7";

const AGENT_ROW = {
  agent_id: VALID_AGENT_ID,
  workspace_id: TEST_PRINCIPAL.workspace_id,
  name: "release-bot-v2",
  owner_user_id: TEST_PRINCIPAL.id,
  created_by: TEST_PRINCIPAL.id,
  created_at: 1,
  updated_at: 2,
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
  app.route("/agents", update);
  return app;
}

describe("POST /agents/update/:agent_id", () => {
  it("merges path-param agent_id with the JSON body into the capability input, returns 200", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return AGENT_ROW;
    });

    const res = await app.request(`/agents/update/${VALID_AGENT_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "release-bot-v2" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(AGENT_ROW);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("agent.update"));
    expect(captured?.input).toEqual({ agent_id: VALID_AGENT_ID, name: "release-bot-v2" });
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

    const res = await app.request("/agents/update/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "release-bot-v2" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("empty name → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request(`/agents/update/${VALID_AGENT_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
