/**
 * Minimal-app test for `POST /docs/add_guest/:doc_id`. Owns the
 * route-layer contract (dispatches `doc.add_guest`, merged param+body
 * input, 200 JSON, body validation — notably the schema-level guest
 * `owner` refusal); capability-side semantics (lifecycle conflicts,
 * ladder, asymmetries) live in the capability's unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { addGuest } from "./add_guest";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

const DOC_ID = "018f0000-0000-7000-8000-0000000000d1";
const SUBJECT_ID = "018f0000-0000-7000-8000-0000000000a5";
const GRANT_ID = "018f0000-0000-7000-8000-0000000000f1";

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
  app.route("/docs", addGuest);
  return app;
}

describe("POST /docs/add_guest/:doc_id", () => {
  it("dispatches doc.add_guest with the merged param+body input, 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      grant_id: GRANT_ID,
      workspace_id: TEST_PRINCIPAL.workspace_id,
      resource_kind: "doc",
      resource_id: DOC_ID,
      subject_kind: "user",
      subject_id: SUBJECT_ID,
      role: "view",
      is_guest: 1,
      created_by: TEST_PRINCIPAL.id,
      created_at: 9000,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/docs/add_guest/${DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject_kind: "user", subject_id: SUBJECT_ID, role: "view" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("doc.add_guest"));
    expect(captured?.input).toEqual({
      doc_id: DOC_ID,
      subject_kind: "user",
      subject_id: SUBJECT_ID,
      role: "view",
    });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("rejects a guest `owner` role → 400 before the dispatcher runs (unmintable by schema)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request(`/docs/add_guest/${DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject_kind: "user", subject_id: SUBJECT_ID, role: "owner" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("rejects a malformed doc_id param → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });
    const res = await app.request("/docs/add_guest/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject_kind: "user", subject_id: SUBJECT_ID, role: "view" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
