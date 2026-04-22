/**
 * Minimal-app test for `POST /workspaces/update`. Owns the route's
 * contract (dispatches `workspace.update`, 200 JSON, zod body); the
 * capability-side semantics (retention bounds, 404, slug rejection,
 * no-op rejection) live in the capability's unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { update } from "./update";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["owner"],
  session_id: null,
  token_id: null,
};

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new OpenAPIHono<ApiEnv>();
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
  app.openapiRoutes([update] as const);
  return app;
}

describe("POST /workspaces/update", () => {
  it("dispatches workspace.update with parsed body, 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      workspace_id: TEST_PRINCIPAL.workspace_id,
      name: "Renamed",
      trash_retention_days: 60,
      settings: { theme: "light" },
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/workspaces/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Renamed",
        trash_retention_days: 60,
        settings: { theme: "light" },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("workspace.update"));
    expect(captured?.input).toEqual({
      name: "Renamed",
      trash_retention_days: 60,
      settings: { theme: "light" },
    });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("rejects `slug` in the body → 400 before the dispatcher runs", async () => {
    // Slug is derived at bootstrap, not mutable via this surface.
    // Strict schema on the route rejects the unknown key.
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/workspaces/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "hijack" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("rejects out-of-range trash_retention_days → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/workspaces/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trash_retention_days: 500 }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
