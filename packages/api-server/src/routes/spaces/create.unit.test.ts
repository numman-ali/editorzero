/**
 * Minimal-app test for `POST /spaces/create`. Owns the route-layer
 * contract (dispatches `space.create`, 200 JSON, zod body, strict
 * keys); capability-side semantics (team-only minting, slug collision)
 * live in the capability's unit test.
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

const SPACE_ID = "018f0000-0000-7000-8000-0000000000e1";

const VALID_BODY = {
  name: "Design Team",
  space_type: "closed",
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
  app.route("/spaces", create);
  return app;
}

describe("POST /spaces/create", () => {
  it("dispatches space.create with parsed body (baseline defaulted), 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      space_id: SPACE_ID,
      workspace_id: TEST_PRINCIPAL.workspace_id,
      kind: "team",
      type: "closed",
      owner_user_id: null,
      name: "Design Team",
      slug: "design-team",
      baseline_access: "view",
      created_by: TEST_PRINCIPAL.id,
      created_at: 7000,
      updated_at: 7000,
      deleted_at: null,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/spaces/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("space.create"));
    // The schema applies the baseline_access default BEFORE dispatch.
    expect(captured?.input).toEqual({ ...VALID_BODY, baseline_access: "view" });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("rejects a bad space_type → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/spaces/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, space_type: "secret" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("rejects unknown body keys (strict — `kind` is not an input) → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/spaces/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, kind: "personal" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
