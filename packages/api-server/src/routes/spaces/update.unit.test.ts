/**
 * Minimal-app test for `POST /spaces/update/:space_id` (pattern P3 —
 * path param + JSON body merged into one capability input). Owns the
 * route-layer contract; capability-side semantics (personal pins,
 * ladder, slug collision) live in the capability's unit test.
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

const SPACE_ID = "018f0000-0000-7000-8000-0000000000e1";

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
  app.route("/spaces", update);
  return app;
}

describe("POST /spaces/update/:space_id", () => {
  it("merges param + body into one input, dispatches space.update, 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      space_id: SPACE_ID,
      workspace_id: TEST_PRINCIPAL.workspace_id,
      kind: "team",
      type: "open",
      owner_user_id: null,
      name: "Renamed",
      slug: "design-team",
      baseline_access: "view",
      created_by: TEST_PRINCIPAL.id,
      created_at: 7000,
      updated_at: 9000,
      deleted_at: null,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/spaces/update/${SPACE_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", space_type: "open" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("space.update"));
    expect(captured?.input).toEqual({
      space_id: SPACE_ID,
      name: "Renamed",
      space_type: "open",
    });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("rejects a malformed space_id param → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });
    const res = await app.request("/spaces/update/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("rejects an empty patch body (at-least-one refine) → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on empty patch");
    });
    const res = await app.request(`/spaces/update/${SPACE_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("rejects space_id in the BODY (strict — it belongs to the path) → 400", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request(`/spaces/update/${SPACE_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space_id: SPACE_ID, name: "Renamed" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
