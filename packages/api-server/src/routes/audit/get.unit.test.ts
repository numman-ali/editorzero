/**
 * Minimal-app test for `GET /audits/get/:audit_id`. Owns the route
 * contract (path param → dispatch input shape, 200 echo). 404 on
 * missing row comes from the trunk's `EditorZeroError` mapper and is
 * covered in the full-stack auth-chain e2e.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../../env";
import { get } from "./get";

const TEST_PRINCIPAL: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["owner"],
  session_id: null,
  token_id: null,
};

const AUDIT_ID = "0199aaaa-0000-7000-8000-000000000001";

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
  app.openapiRoutes([get] as const);
  return app;
}

describe("GET /audits/get/:audit_id", () => {
  it("dispatches audit.get with the path-param audit_id + echoes the row at 200", async () => {
    let captured: DispatchInvocation | undefined;
    const output = {
      id: AUDIT_ID,
      workspace_id: TEST_PRINCIPAL.workspace_id,
      capability_id: "doc.create",
      category: "mutation" as const,
      principal_kind: "user" as const,
      principal_id: TEST_PRINCIPAL.id,
      acting_as_user_id: null,
      session_id: null,
      token_id: null,
      subject_kind: "doc",
      subject_id: null,
      outcome: "allow" as const,
      deny_reason: null,
      input_hash: "hash",
      effect: { kind: "doc.create" },
      duration_ms: 5,
      trace_id: null,
      created_at: 1000,
      collapsed_count: 1,
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request(`/audits/get/${AUDIT_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("audit.get"));
    expect(captured?.input).toEqual({ audit_id: AUDIT_ID });
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
  });
});
