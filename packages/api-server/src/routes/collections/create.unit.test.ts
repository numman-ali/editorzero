/**
 * Minimal-app test for `POST /collections/create` (ADR 0021 §Per-route
 * test posture). Mirrors `routes/docs/create.unit.test.ts`.
 *
 * Owns: the route's own contract (dispatches `collection.create` with
 * parsed body + principal-derived access; 201 JSON; zod validation
 * 400 before the dispatcher runs). Does not own: dispatcher wiring,
 * parent-validation semantics (those are in the capability's unit
 * test).
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
  roles: ["member"],
  session_id: null,
  token_id: null,
};

interface FixtureOutput {
  readonly collection_id: string;
  readonly workspace_id: string;
  readonly parent_id: string | null;
  readonly title: string;
  readonly slug: string;
  readonly order_key: string;
}

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
  app.route("/collections", create);
  return app;
}

describe("POST /collections/create", () => {
  it("dispatches collection.create with parsed body + principal-derived access, returns 201 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      collection_id: "018f0000-0000-7000-8000-0000000000c1",
      workspace_id: TEST_PRINCIPAL.workspace_id,
      parent_id: null,
      title: "Reference",
      slug: "reference",
      order_key: "018f0000-0000-7000-8000-0000000000c1",
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/collections/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Reference" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("collection.create"));
    expect(captured?.input).toEqual({ title: "Reference" });
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("forwards an explicit `parent_id` on the body to the dispatcher input", async () => {
    let captured: DispatchInvocation | undefined;
    const PARENT_ID = "018f0000-0000-7000-8000-0000000000d1";
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return {
        collection_id: "018f0000-0000-7000-8000-0000000000d2",
        workspace_id: TEST_PRINCIPAL.workspace_id,
        parent_id: PARENT_ID,
        title: "Child",
        slug: "child",
        order_key: "018f0000-0000-7000-8000-0000000000d2",
      };
    });

    const res = await app.request("/collections/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Child", parent_id: PARENT_ID }),
    });
    expect(res.status).toBe(201);
    expect(captured?.input).toEqual({ title: "Child", parent_id: PARENT_ID });
  });

  it("empty title → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request("/collections/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("unrecognized keys → 400 (input schema is .strict)", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid body");
    });

    const res = await app.request("/collections/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X", stray: 1 }),
    });
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
