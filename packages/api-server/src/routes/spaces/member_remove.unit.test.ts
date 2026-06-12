/**
 * Minimal-app test for `POST /spaces/member_remove`. Owns the
 * route-layer contract (dispatches `space.member_remove`, 200 JSON,
 * body validation); capability-side semantics live in the capability's
 * unit test.
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
  roles: ["admin"],
  session_id: null,
  token_id: null,
};

const SPACE_ID = "018f0000-0000-7000-8000-0000000000e1";
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
  app.route("/spaces", memberRemove);
  return app;
}

describe("POST /spaces/member_remove/:space_id", () => {
  it("dispatches space.member_remove with the merged param+body input, 200 preimage JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      workspace_id: TEST_PRINCIPAL.workspace_id,
      space_id: SPACE_ID,
      user_id: TARGET_ID,
      role: "edit",
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/spaces/member_remove/${SPACE_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: TARGET_ID }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("space.member_remove"));
    expect(captured?.input).toEqual({ space_id: SPACE_ID, user_id: TARGET_ID });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("rejects an unknown body key → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request(`/spaces/member_remove/${SPACE_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: TARGET_ID, purge: true }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
