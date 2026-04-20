/**
 * Minimal-app test for `GET /docs/list` (ADR 0021 §Per-route test posture).
 *
 * Mounts only this route on a fresh `OpenAPIHono<ApiEnv>` + a fixture
 * middleware chain that seeds `c.var.principal` + `c.var.dispatcher`.
 * Exercises the route's full input→dispatch→response pipeline without
 * pulling in the trunk, Better Auth, or a real `createApiDispatcher`.
 *
 * **What this test owns.** The route's own contract:
 *   1. It dispatches `doc.list` with `capability_id: "doc.list"`, the
 *      principal off `c.var`, and an `access.workspace_id` derived from
 *      the principal.
 *   2. It returns the dispatcher's output through `c.json` with status
 *      200.
 *
 * **What this test does NOT own.** The dispatcher's pipeline (parse →
 * gate → invoke → parse → audit) — that's
 * `packages/dispatcher/src/writepath.integration.test.ts`. The trunk's
 * middleware-chain wiring — that's
 * `composition/auth-chain.integration.test.ts`.
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
  roles: ["member"],
  session_id: null,
  token_id: null,
};

interface FixtureOutput {
  readonly docs: ReadonlyArray<{
    id: string;
    title: string;
    slug: string;
    collection_id: string | null;
    visibility: "workspace" | "public" | "private";
    created_at: number;
    updated_at: number;
  }>;
}

function buildApp(dispatch: (invocation: DispatchInvocation) => Promise<unknown>) {
  const app = new OpenAPIHono<ApiEnv>();
  const fakeDispatcher = {
    dispatch,
    // biome-ignore lint/suspicious/noExplicitAny: `deps` is not read by the route; a full mock would over-commit to the shape.
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

describe("GET /docs/list", () => {
  it("dispatches doc.list with principal + access derived from c.var, returns dispatcher output as JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      docs: [
        {
          id: "018f0000-0000-7000-8000-0000000000a1",
          title: "Sample",
          slug: "sample",
          collection_id: null,
          visibility: "workspace",
          created_at: 1,
          updated_at: 1,
        },
      ],
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/docs/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("doc.list"));
    expect(captured?.input).toEqual({});
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("empty docs list is a valid response (new workspace)", async () => {
    const app = buildApp(async () => ({ docs: [] }));
    const res = await app.request("/docs/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body.docs).toHaveLength(0);
  });
});
