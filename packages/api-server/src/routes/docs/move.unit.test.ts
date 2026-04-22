/**
 * Minimal-app test for `POST /docs/move`. Owns the route's contract
 * (dispatches `doc.move`, returns 200 JSON, param+body validation);
 * capability-side semantics live in the capability's unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
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

const DOC_ID = "018f0000-0000-7000-8000-0000000000d1";
const COLLECTION_ID = "018f0000-0000-7000-8000-0000000000c1";

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
  app.openapiRoutes([move] as const);
  return app;
}

describe("POST /docs/move", () => {
  it("dispatches doc.move with parsed body, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      doc_id: DOC_ID,
      new_collection_id: COLLECTION_ID,
      new_order_key: "018f0000-0000-7000-8000-000000000111",
      updated_at: 42,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/docs/move/${DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_collection_id: COLLECTION_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("doc.move"));
    expect(captured?.input).toEqual({
      doc_id: DOC_ID,
      new_collection_id: COLLECTION_ID,
    });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });

  it("accepts explicit null new_collection_id (move to workspace root)", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      doc_id: DOC_ID,
      new_collection_id: null,
      new_order_key: "018f0000-0000-7000-8000-000000000111",
      updated_at: 42,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });
    const res = await app.request(`/docs/move/${DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_collection_id: null }),
    });
    expect(res.status).toBe(200);
    expect(captured?.input).toEqual({
      doc_id: DOC_ID,
      new_collection_id: null,
    });
  });

  it("malformed uuid in path → 400", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid path param");
    });
    const res = await app.request("/docs/move/not-a-uuid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_collection_id: null }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("missing new_collection_id field → 400 (body schema is .strict)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request(`/docs/move/${DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("unrecognized body keys → 400 (body schema is .strict)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });
    const res = await app.request(`/docs/move/${DOC_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ new_collection_id: null, stray: 1 }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
