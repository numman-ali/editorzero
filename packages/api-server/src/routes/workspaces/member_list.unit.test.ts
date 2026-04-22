/**
 * Minimal-app test for `GET /workspaces/member_list`. Owns the
 * route-layer contract (dispatches `workspace.member_list`, 200 JSON,
 * zod query, cursor refine); capability-side semantics (active-only
 * projection, Layer-2 scoping, collapse policy) live in the
 * capability's unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { memberList } from "./member_list";

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
  app.openapiRoutes([memberList] as const);
  return app;
}

describe("GET /workspaces/member_list", () => {
  it("dispatches workspace.member_list with parsed query, 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      members: [
        {
          user_id: "018f0000-0000-7000-8000-0000000000a1",
          role: "owner",
          created_at: 100,
          updated_at: 100,
        },
      ],
      next_cursor: null,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/workspaces/member_list?limit=25&role=owner");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("workspace.member_list"));
    // `limit` coerced to number at the route boundary; `role` stays an enum.
    expect(captured?.input).toEqual({ limit: 25, role: "owner" });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("applies the default limit when omitted", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return { members: [], next_cursor: null };
    });

    const res = await app.request("/workspaces/member_list");
    expect(res.status).toBe(200);
    expect((captured?.input as { limit: number }).limit).toBe(50);
  });

  it("passes through a valid composite cursor to the dispatcher", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return { members: [], next_cursor: null };
    });

    const res = await app.request(
      "/workspaces/member_list?limit=10&before_created_at=200&before_user_id=018f0000-0000-7000-8000-0000000000b1",
    );
    expect(res.status).toBe(200);
    expect(captured?.input).toEqual({
      limit: 10,
      before_created_at: 200,
      before_user_id: "018f0000-0000-7000-8000-0000000000b1",
    });
  });

  it("rejects half-a-cursor (before_created_at without before_user_id) → 400", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid query");
    });
    const res = await app.request("/workspaces/member_list?before_created_at=200");
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("rejects half-a-cursor (before_user_id without before_created_at) → 400", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid query");
    });
    const res = await app.request(
      "/workspaces/member_list?before_user_id=018f0000-0000-7000-8000-0000000000b1",
    );
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("rejects an unknown role filter → 400", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid query");
    });
    const res = await app.request("/workspaces/member_list?role=bogus");
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("rejects limit above 200 → 400", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid query");
    });
    const res = await app.request("/workspaces/member_list?limit=500");
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
