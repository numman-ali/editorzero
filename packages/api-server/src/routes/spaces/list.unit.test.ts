/**
 * Minimal-app test for `GET /spaces/list` (ADR 0021 §Per-route test
 * posture; ADR 0029 code-first shape; the `doc.list` empty-input
 * variant). The route's contract: empty capability input minted by the
 * handler, dispatch wiring, 200 echo. The per-row visibility filter
 * lives in the capability suite.
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
  readonly spaces: ReadonlyArray<{
    space_id: string;
    workspace_id: string;
    kind: "team" | "personal";
    type: "open" | "closed" | "private";
    owner_user_id: string | null;
    name: string;
    slug: string;
    baseline_access: "edit" | "comment" | "view";
    created_by: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
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
  app.route("/spaces", list);
  return app;
}

describe("GET /spaces/list", () => {
  it("dispatches space.list with empty input + principal-derived access, returns 200 JSON", async () => {
    let captured: DispatchInvocation | undefined;
    const output: FixtureOutput = {
      spaces: [
        {
          space_id: "018f0000-0000-7000-8000-0000000000e1",
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
        },
      ],
    };
    const app = buildApp(async (invocation) => {
      captured = invocation;
      return output;
    });

    const res = await app.request("/spaces/list", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body).toEqual(output);

    expect(captured).toBeDefined();
    expect(captured?.capability_id).toBe(CapabilityId("space.list"));
    expect(captured?.input).toEqual({});
    expect(captured?.principal).toBe(TEST_PRINCIPAL);
    expect(captured?.access).toEqual({ workspace_id: TEST_PRINCIPAL.workspace_id });
    expect(captured?.trace_id).toBeNull();
  });

  it("an empty spaces list is a valid response (agent with no grants)", async () => {
    const app = buildApp(async () => ({ spaces: [] }));
    const res = await app.request("/spaces/list", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FixtureOutput;
    expect(body.spaces).toHaveLength(0);
  });
});
