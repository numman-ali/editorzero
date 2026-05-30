/**
 * Minimal-app test for `POST /collections/move` (ADR 0029 code-first
 * shape). Owns the route's contract (dispatches `collection.move`,
 * returns 200 JSON, param+body validation); capability-side semantics
 * (cycle, depth, slug) live in the capability's unit test.
 *
 * Mounts only this route's `Hono<ApiEnv>` sub-app at `/collections` on a
 * fresh trunk + a fixture middleware seeding `c.var.principal` +
 * `c.var.dispatcher`. The route's validators apply each field's
 * `.transform()` (wire string → branded `CollectionId`); the brand is a
 * compile-time cast (the runtime value is the same string), so the
 * captured-input `toEqual` assertions against plain strings still hold.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { move } from "./move";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

const TARGET_ID = "018f0000-0000-7000-8000-0000000000c1";
const NEW_PARENT_ID = "018f0000-0000-7000-8000-0000000000c2";

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
  app.route("/collections", move);
  return app;
}

describe("POST /collections/move", () => {
  it("dispatches collection.move with parsed body, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      collection_id: TARGET_ID,
      new_parent_id: NEW_PARENT_ID,
      new_order_key: "018f0000-0000-7000-8000-000000000111",
      updated_at: 42,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/collections/move/${TARGET_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_parent_id: NEW_PARENT_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("collection.move"));
    expect(captured?.input).toEqual({
      collection_id: TARGET_ID,
      new_parent_id: NEW_PARENT_ID,
    });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("accepts explicit null new_parent_id (move to workspace root)", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      collection_id: TARGET_ID,
      new_parent_id: null,
      new_order_key: "018f0000-0000-7000-8000-000000000111",
      updated_at: 42,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });
    const res = await app.request(`/collections/move/${TARGET_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_parent_id: null }),
    });
    expect(res.status).toBe(200);
    expect(captured?.input).toEqual({
      collection_id: TARGET_ID,
      new_parent_id: null,
    });
  });

  it("malformed uuid in path → 400", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid path param");
    });
    const res = await app.request("/collections/move/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_parent_id: null }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("missing new_parent_id field → 400 (body schema is .strict)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request(`/collections/move/${TARGET_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("unrecognized body keys → 400 (body schema is .strict)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request(`/collections/move/${TARGET_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_parent_id: null, stray: 1 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
