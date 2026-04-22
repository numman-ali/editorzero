/**
 * Minimal-app test for `GET /workspaces/get`. Owns the route's
 * contract (dispatches `workspace.get`, returns 200 JSON); capability-
 * side semantics (404 on soft-delete, settings JSON parse) live in
 * the capability's unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { get } from "./get";

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
  app.openapiRoutes([get] as const);
  return app;
}

describe("GET /workspaces/get", () => {
  it("dispatches workspace.get with empty input, echoes capability output at 200", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      workspace_id: TEST_PRINCIPAL.workspace_id,
      slug: "alice-abc123",
      name: "alice's workspace",
      trash_retention_days: 30,
      created_by: TEST_PRINCIPAL.id,
      created_at: 100,
      settings: { theme: "dark" },
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/workspaces/get");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("workspace.get"));
    expect(captured?.input).toEqual({});
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });
});
