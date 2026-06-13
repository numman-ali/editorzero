/**
 * Minimal-app test for `GET /agents/list` (ADR 0021 §Per-route test
 * posture; ADR 0029 code-first shape). Empty-input variant — no
 * validator arm; the route mints the empty object. Visibility
 * partitioning lives in the capability suite.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { list } from "./list";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

const AGENT_ROW = {
  agent_id: "018f0000-0000-7000-8000-0000000000a7",
  workspace_id: TEST_PRINCIPAL.workspace_id,
  name: "release-bot",
  owner_user_id: TEST_PRINCIPAL.id,
  created_by: TEST_PRINCIPAL.id,
  created_at: 1,
  updated_at: 1,
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
  app.route("/agents", list);
  return app;
}

describe("GET /agents/list", () => {
  it("dispatches agent.list with the empty input + principal-derived access, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return { agents: [AGENT_ROW] };
    });

    const res = await app.request("/agents/list", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [AGENT_ROW] });

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("agent.list"));
    expect(captured?.input).toEqual({});
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });
});
