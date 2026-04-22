/**
 * Minimal-app test for `GET /audits/list`. Owns the route's contract
 * (query-string coercion, dispatch with the coerced input, 200 JSON
 * echo). Capability semantics (filter ordering, composite cursor,
 * tenant scoping) live in the capability unit test.
 */

import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { OpenAPIHono } from "@hono/zod-openapi";
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
  app.openapiRoutes([list] as const);
  return app;
}

describe("GET /audits/list", () => {
  it("dispatches audit.list with the default limit when no query is provided", async () => {
    let captured: DispatchInvocation | undefined;
    const output = { events: [], next_cursor: null };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/audits/list");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
    expect(captured?.capability_id).toBe(CapabilityId("audit.list"));
    expect(captured?.input).toEqual({ limit: 50 });
  });

  it("coerces query-string numbers + preserves filter shape to the dispatcher", async () => {
    let captured: DispatchInvocation | undefined;
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return { events: [], next_cursor: null };
    });

    const res = await app.request(
      "/audits/list?limit=25&since=100&until=200&subject_kind=doc&subject_id=0199aaaa-0000-7000-8000-0000000000d1&outcome=allow",
    );

    expect(res.status).toBe(200);
    expect(captured?.input).toEqual({
      limit: 25,
      since: 100,
      until: 200,
      subject_kind: "doc",
      subject_id: "0199aaaa-0000-7000-8000-0000000000d1",
      outcome: "allow",
    });
  });

  it("echoes a populated response body at 200", async () => {
    const output = {
      events: [
        {
          id: "0199aaaa-0000-7000-8000-000000000001",
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
        },
      ],
      next_cursor: {
        before_created_at: 1000,
        before_id: "0199aaaa-0000-7000-8000-000000000001",
      },
    };
    const app = buildApp(async () => output);

    const res = await app.request("/audits/list?limit=1");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(output);
  });
});
