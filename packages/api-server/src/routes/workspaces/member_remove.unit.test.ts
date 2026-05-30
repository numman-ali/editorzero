/**
 * Minimal-app test for `POST /workspaces/member_remove` (ADR 0021 §Per-route
 * test posture; ADR 0029 code-first shape). Mounts only this route's
 * `Hono<ApiEnv>` sub-app at `/workspaces` on a fresh trunk + a fixture
 * middleware that seeds `c.var.principal` + `c.var.dispatcher`. Owns the
 * route-layer contract (dispatches `workspace.member_remove`, 200 JSON,
 * zod body, strict keys); capability-side semantics (last-owner invariant,
 * 404-on-re-remove, Layer-2 scoping) live in the capability's unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { memberRemove } from "./member_remove";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["owner"],
  session_id: null,
  token_id: null,
};

const TARGET_ID = "018f0000-0000-7000-8000-0000000000b1";

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
  app.route("/workspaces", memberRemove);
  return app;
}

describe("POST /workspaces/member_remove", () => {
  it("dispatches workspace.member_remove with parsed body, 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      workspace_id: TEST_PRINCIPAL.workspace_id,
      user_id: TARGET_ID,
      deleted_at: 9999,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/workspaces/member_remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: TARGET_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("workspace.member_remove"));
    expect(captured?.input).toEqual({ user_id: TARGET_ID });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("rejects missing user_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/workspaces/member_remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("rejects empty user_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/workspaces/member_remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("rejects unknown body keys (strict) → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/workspaces/member_remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: TARGET_ID, workspace_id: "hijack" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
