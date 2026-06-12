/**
 * Minimal-app test for `GET /spaces/get/:space_id` (ADR 0021 §Per-route
 * test posture; ADR 0029 code-first shape). Mounts only this route's
 * sub-app at `/spaces` on a fresh trunk + a fixture middleware that
 * seeds `c.var.principal` + `c.var.dispatcher`. The route's contract:
 * P2 param validation (the capability input schema IS the param
 * validator), dispatch wiring, 200 echo. Visibility/404 semantics live
 * in the capability suite; error→status mapping in `lib/errors`.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { get } from "./get";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

const VALID_SPACE_ID = "018f0000-0000-7000-8000-0000000000e1";

interface FixtureOutput {
  readonly space_id: string;
  readonly workspace_id: string;
  readonly kind: "team" | "personal";
  readonly type: "open" | "closed" | "private";
  readonly owner_user_id: string | null;
  readonly name: string;
  readonly slug: string;
  readonly baseline_access: "edit" | "comment" | "view";
  readonly created_by: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
}

const SPACE_ROW: FixtureOutput = {
  space_id: VALID_SPACE_ID,
  workspace_id: TEST_PRINCIPAL.workspace_id,
  kind: "team",
  type: "open",
  owner_user_id: null,
  name: "Engineering",
  slug: "engineering",
  baseline_access: "view",
  created_by: "018f0000-0000-7000-8000-0000000000a1",
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
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
  app.route("/spaces", get);
  return app;
}

describe("GET /spaces/get/:space_id", () => {
  it("dispatches space.get with path-param space_id + principal-derived access, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return SPACE_ROW;
    });

    const res = await app.request(`/spaces/get/${VALID_SPACE_ID}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(SPACE_ROW);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("space.get"));
    expect(captured?.input).toEqual({ space_id: VALID_SPACE_ID });
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("non-UUID space_id → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid param");
    });

    const res = await app.request("/spaces/get/not-a-uuid", { method: "GET" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });
});
