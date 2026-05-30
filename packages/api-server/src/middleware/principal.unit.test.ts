/**
 * `createPrincipalMiddleware` — unit tests.
 *
 * Covers the two legs of the resolver contract:
 *   1. Resolver returns a Principal → middleware sets `c.var.principal`
 *      and calls `next()`.
 *   2. Resolver returns `null` → middleware short-circuits with 401
 *      and does NOT call `next()`.
 *
 * Uses a tiny probe-route (`GET /probe`) that reads `c.var.principal`
 * back onto the response body so the test can confirm the variable
 * was set. An async resolver covers the Better-Auth-style DB-hitting
 * case without relying on Better Auth itself.
 */

import { UserId, WorkspaceId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiEnv } from "../env";
import { createPrincipalMiddleware, type PrincipalResolver } from "./principal";

const TEST_USER: UserPrincipal = {
  kind: "user",
  id: UserId("018f0000-0000-7000-8000-000000000002"),
  workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000001"),
  roles: ["member"],
  session_id: null,
  token_id: null,
};

function buildProbeApp(resolver: PrincipalResolver) {
  const app = new Hono<ApiEnv>();
  app.use("*", createPrincipalMiddleware({ resolve: resolver }));
  app.get("/probe", (c) => {
    const principal = c.var.principal;
    return c.json({ kind: principal.kind, workspace_id: principal.workspace_id });
  });
  return app;
}

describe("createPrincipalMiddleware", () => {
  it("sets c.var.principal and calls next() when resolver returns a Principal", async () => {
    const app = buildProbeApp(() => TEST_USER);
    const res = await app.request("/probe");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; workspace_id: string };
    expect(body.kind).toBe("user");
    expect(body.workspace_id).toBe(TEST_USER.workspace_id);
  });

  it("accepts async resolvers (DB-backed session lookup case)", async () => {
    const app = buildProbeApp(async () => {
      // Simulate a DB hit without actually touching the DB.
      await new Promise((r) => setTimeout(r, 0));
      return TEST_USER;
    });
    const res = await app.request("/probe");
    expect(res.status).toBe(200);
  });

  it("returns 401 without calling next() when resolver returns null", async () => {
    let nextWasCalled = false;
    const app = new Hono<ApiEnv>();
    app.use("*", createPrincipalMiddleware({ resolve: () => null }));
    app.get("/probe", (c) => {
      nextWasCalled = true;
      return c.json({ ok: true });
    });
    const res = await app.request("/probe");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
    expect(nextWasCalled).toBe(false);
  });

  it("rethrows resolver errors so the global error handler can project them", async () => {
    const app = new Hono<ApiEnv>();
    app.use(
      "*",
      createPrincipalMiddleware({
        resolve: () => {
          throw new Error("db timeout");
        },
      }),
    );
    app.get("/probe", (c) => c.json({ ok: true }));
    // Hono catches the throw and emits a 500 by default; we just
    // assert that the middleware did NOT swallow it (would be a 401
    // or a 200) and did NOT land on `/probe`.
    const res = await app.request("/probe");
    expect(res.status).toBe(500);
  });
});
