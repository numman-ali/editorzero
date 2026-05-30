/**
 * Minimal-app test for `GET /collections/list` (ADR 0021 §Per-route test
 * posture; ADR 0029 code-first shape). Mounts only this route's
 * `Hono<ApiEnv>` sub-app at `/collections` on a fresh trunk + a fixture
 * middleware that seeds `c.var.principal` + `c.var.dispatcher`.
 *
 * Owns: the route's own contract (dispatches `collection.list` with the
 * empty input + principal-derived access; returns dispatcher output as
 * 200 JSON). Does not own: dispatcher wiring or auth-cookie roundtrip.
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
  roles: ["member"],
  session_id: null,
  token_id: null,
};

interface FixtureOutput {
  readonly collections: ReadonlyArray<{
    id: string;
    title: string;
    slug: string;
    parent_id: string | null;
    created_at: number;
    updated_at: number;
  }>;
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
  app.route("/collections", list);
  return app;
}

describe("GET /collections/list", () => {
  it("dispatches collection.list with principal + access derived from c.var, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      collections: [
        {
          id: "018f0000-0000-7000-8000-0000000000c1",
          title: "Reference",
          slug: "reference",
          parent_id: null,
          created_at: 1,
          updated_at: 1,
        },
      ],
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/collections/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("collection.list"));
    expect(captured?.input).toEqual({});
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("empty collections list is a valid response (fresh workspace)", async () => {
    const app = buildApp(async () => ({ collections: [] }));
    const res = await app.request("/collections/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body.collections).toHaveLength(0);
  });
});
