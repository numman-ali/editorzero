/**
 * Minimal-app test for `POST /permissions/grant`. Owns the route-layer
 * contract (dispatches `permission.grant`, 200 JSON, zod body, strict
 * keys); capability-side semantics (authority ladder, subject rules,
 * upsert branches) live in the capability's unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { grant } from "./grant";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["owner"],
  session_id: null,
  token_id: null,
};

const DOC_ID = "018f0000-0000-7000-8000-0000000000d1";
const GRANT_ID = "018f0000-0000-7000-8000-0000000000f1";
const SUBJECT_ID = "018f0000-0000-7000-8000-0000000000a3";

const VALID_BODY = {
  resource_kind: "doc",
  resource_id: DOC_ID,
  subject_kind: "user",
  subject_id: SUBJECT_ID,
  role: "view",
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
  app.route("/permissions", grant);
  return app;
}

describe("POST /permissions/grant", () => {
  it("dispatches permission.grant with parsed body, 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      grant_id: GRANT_ID,
      workspace_id: TEST_PRINCIPAL.workspace_id,
      resource_kind: "doc",
      resource_id: DOC_ID,
      subject_kind: "user",
      subject_id: SUBJECT_ID,
      role: "view",
      is_guest: 0,
      created_by: TEST_PRINCIPAL.id,
      created_at: 7000,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/permissions/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("permission.grant"));
    expect(captured?.input).toEqual(VALID_BODY);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("rejects an unknown resource_kind → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/permissions/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, resource_kind: "collection" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("rejects a non-UUIDv7 resource_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/permissions/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, resource_id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("rejects unknown body keys (strict) → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request("/permissions/grant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, is_guest: 1 }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
