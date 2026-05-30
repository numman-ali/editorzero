/**
 * Minimal-app test for `POST /collections/restore` (ADR 0021 §Per-route
 * test posture; ADR 0029 code-first shape). Mounts only this route's
 * `Hono<ApiEnv>` sub-app at `/collections` on a fresh trunk + a fixture
 * middleware that seeds `c.var.principal` + `c.var.dispatcher`.
 *
 * Owns the route's contract (dispatches `collection.restore` with the
 * parsed path param + principal-derived access, returns 200 JSON,
 * malformed-id → 400 before the dispatcher runs); parent-deleted refusal
 * semantics live in the capability's unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { restore } from "./restore";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

const TARGET_ID = "018f0000-0000-7000-8000-0000000000c1";

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
  app.route("/collections", restore);
  return app;
}

describe("POST /collections/restore", () => {
  it("dispatches collection.restore, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = { collection_id: TARGET_ID };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/collections/restore/${TARGET_ID}`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("collection.restore"));
    expect(captured?.input).toEqual({ collection_id: TARGET_ID });
  });

  it("malformed uuid in path → 400", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid path param");
    });
    const res = await app.request("/collections/restore/not-a-uuid", {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
