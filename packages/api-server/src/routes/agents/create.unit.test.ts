/**
 * Minimal-app test for `POST /agents/create` (ADR 0021 §Per-route test
 * posture; ADR 0029 code-first shape). Mounts only this route's
 * sub-app at `/agents` on a fresh trunk + a fixture middleware that
 * seeds `c.var.principal` + `c.var.dispatcher`. The route's contract:
 * body validation via the capability schema (SSOT), dispatch wiring,
 * 200 echo. Ownership-anchoring and name-collision semantics live in
 * the capability suite; error→status mapping in `lib/errors`.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { create } from "./create";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["admin"],
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
  app.route("/agents", create);
  return app;
}

describe("POST /agents/create", () => {
  it("dispatches agent.create with the JSON body + principal-derived access, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return AGENT_ROW;
    });

    const res = await app.request("/agents/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "release-bot" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(AGENT_ROW);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("agent.create"));
    expect(captured?.input).toEqual({ name: "release-bot" });
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("whitespace-only name → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request("/agents/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("unknown body key → 400 (strict schema)", async () => {
    const app = buildApp(async () => {
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request("/agents/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "release-bot", owner_user_id: TEST_PRINCIPAL.id }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
  });
});
