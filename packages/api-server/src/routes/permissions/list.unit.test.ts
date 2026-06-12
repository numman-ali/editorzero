/**
 * Minimal-app test for `GET /permissions/list`. Owns the route-layer
 * contract (dispatches `permission.list`, query-string coercion, 200
 * JSON, strict keys, cursor-pair rail); capability-side semantics
 * (visibility rule, pagination mechanics) live in the capability's
 * unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { list } from "./list";

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
  app.route("/permissions", list);
  return app;
}

describe("GET /permissions/list", () => {
  it("dispatches permission.list with coerced query, 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      grants: [
        {
          grant_id: GRANT_ID,
          workspace_id: TEST_PRINCIPAL.workspace_id,
          resource_kind: "doc",
          resource_id: DOC_ID,
          subject_kind: "user",
          subject_id: "018f0000-0000-7000-8000-0000000000a3",
          role: "view",
          is_guest: 0,
          created_by: TEST_PRINCIPAL.id,
          created_at: 7000,
        },
      ],
      next_cursor: null,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(
      `/permissions/list?resource_kind=doc&resource_id=${DOC_ID}&limit=25`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("permission.list"));
    // z.coerce turned the query-string "25" into the number 25.
    expect(captured?.input).toEqual({
      resource_kind: "doc",
      resource_id: DOC_ID,
      limit: 25,
    });
  });

  it("rejects a lone cursor half → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid query");
    });
    const res = await app.request(
      `/permissions/list?resource_kind=doc&resource_id=${DOC_ID}&before_created_at=5`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "validation_failed" });
    expect(dispatchCalled).toBe(false);
  });

  it("rejects an unknown resource_kind → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid query");
    });
    const res = await app.request(
      `/permissions/list?resource_kind=collection&resource_id=${DOC_ID}`,
    );
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });

  it("rejects unknown query keys (strict) → 400 before the dispatcher runs", async () => {
    let dispatchCalled = false;
    const app = buildApp(async () => {
      dispatchCalled = true;
      throw new Error("dispatcher must not run on invalid query");
    });
    const res = await app.request(
      `/permissions/list?resource_kind=doc&resource_id=${DOC_ID}&subject_id=x`,
    );
    expect(res.status).toBe(400);
    expect(dispatchCalled).toBe(false);
  });
});
