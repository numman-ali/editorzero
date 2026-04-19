/**
 * Full auth chain integration test — trunk + Better Auth + principal
 * middleware + dispatcher middleware against a real in-memory SQLite
 * driver.
 *
 * The unit tests in `middleware/principal.unit.test.ts`,
 * `middleware/dispatcher.unit.test.ts`, `auth/create-auth.integration.
 * test.ts`, and `app.unit.test.ts` each pin one seam of the auth chain.
 * This file proves the composition works *together*:
 *
 *   1. `createApiApp({ auth, dispatcher })` returns a trunk that
 *      serves Better Auth's `/auth/*` endpoints live against the
 *      shared SQLite DB.
 *   2. `POST /auth/sign-up/email` → user row with minted
 *      `workspaceId`, HTTP 200.
 *   3. `POST /auth/sign-in/email` → `Set-Cookie: better-auth.
 *      session_token=...` on the response.
 *   4. A request carrying that cookie through
 *      `createPrincipalMiddleware({ resolve: createBetterAuthResolver(
 *      auth) })` materialises a `UserPrincipal` on `c.var.principal`
 *      with the matching `workspace_id`.
 *   5. The same request carries a `Dispatcher` on `c.var.dispatcher`
 *      via `createDispatcherMiddleware`, so a capability route that
 *      reads `c.var.dispatcher` can invoke capabilities.
 *
 * The "capability route" here is a test-only probe mounted on the
 * trunk post-factory. That's intentional — we're proving the
 * *middleware composition* works end-to-end today. The first real
 * capability route lands in the next slice and reuses this exact
 * composition shape.
 */

import { createAuth, createBetterAuthResolver, runAuthMigrations } from "@editorzero/auth";
import { createRegistry } from "@editorzero/capabilities";
import { createSqliteDriver, SQLITE_FULL_DDL, type SqliteDriver } from "@editorzero/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiApp } from "../app";
import { createDispatcherMiddleware } from "../middleware/dispatcher";
import { createPrincipalMiddleware } from "../middleware/principal";
import { createApiDispatcher } from "./createApiDispatcher";

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie
    .split(/,(?=\s*[^ ;]+=)/u)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}

async function buildStack() {
  const auth = createAuth({
    driver,
    baseURL: "http://localhost:3000",
    secret: "test-secret-do-not-use-in-production-at-all",
    trustedOrigins: ["http://localhost:3000"],
  });
  await runAuthMigrations(auth);
  // Empty registry — the probe route in these tests does not call
  // `dispatcher.dispatch`, it only asserts the middleware materialised
  // a dispatcher onto `c.var`. The dispatcher's own dispatch-path
  // integration is covered in `createApiDispatcher.integration.test.ts`.
  const registry = createRegistry([]);
  const dispatcher = createApiDispatcher({ driver, registry });
  const trunk = createApiApp({ auth, dispatcher });
  return { auth, dispatcher, trunk };
}

async function signUp(trunk: Awaited<ReturnType<typeof buildStack>>["trunk"], email: string) {
  return trunk.request("/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      password: "correct-horse-battery-staple",
      name: email.split("@")[0],
    }),
  });
}

async function signIn(trunk: Awaited<ReturnType<typeof buildStack>>["trunk"], email: string) {
  return trunk.request("/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
  });
}

describe("api-server auth chain (trunk + Better Auth + middleware)", () => {
  it("sign-up through the trunk creates a user row with a minted workspaceId", async () => {
    const { trunk } = await buildStack();
    const res = await signUp(trunk, "alice@example.com");
    expect(res.status).toBe(200);

    const users = await driver
      .system()
      // biome-ignore lint/suspicious/noExplicitAny: Better Auth's `user` table is outside our Database type.
      .selectFrom("user" as any)
      .select(["email" as never, "workspaceId" as never])
      .execute();
    expect(users).toHaveLength(1);
    const user = users[0] as { email: string; workspaceId: string };
    expect(user.email).toBe("alice@example.com");
    expect(user.workspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
  });

  it("sign-in through the trunk returns a session cookie the resolver can consume", async () => {
    const { auth, trunk } = await buildStack();
    await signUp(trunk, "bob@example.com");

    const signInRes = await signIn(trunk, "bob@example.com");
    expect(signInRes.status).toBe(200);

    const cookie = sessionCookieFrom(signInRes);
    expect(cookie).toContain("session_token");

    const resolver = createBetterAuthResolver(auth);
    const principal = await resolver(new Headers({ cookie }));
    expect(principal).not.toBeNull();
    if (principal === null) throw new Error("unreachable");
    expect(principal.kind).toBe("user");
    expect(principal.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
  });

  it("principal + dispatcher middleware attach to c.var for an authenticated probe route", async () => {
    const { auth, dispatcher, trunk } = await buildStack();
    // Mount the probe BEFORE the first request — Hono's SmartRouter
    // lazily builds its match tree on first request, and once built it
    // refuses further `.use()` / `.get()` calls. Real capability routes
    // compose through `openapiRoutes([...] as const)` at factory time,
    // so they land before any request too. This test uses the same
    // mount-early discipline.
    trunk.use(
      "/probe",
      createPrincipalMiddleware({
        resolve: (c) => createBetterAuthResolver(auth)(c.req.raw.headers),
      }),
    );
    trunk.use("/probe", createDispatcherMiddleware({ dispatcher }));
    trunk.get("/probe", (c) => {
      const principal = c.var.principal;
      const hasDispatcher = typeof c.var.dispatcher.dispatch === "function";
      if (principal.kind !== "user") {
        return c.json({ ok: false as const, reason: "not-user" });
      }
      return c.json({
        ok: true as const,
        workspace_id: principal.workspace_id,
        has_dispatcher: hasDispatcher,
      });
    });

    await signUp(trunk, "carol@example.com");
    const signInRes = await signIn(trunk, "carol@example.com");
    const cookie = sessionCookieFrom(signInRes);

    const probeRes = await trunk.request("/probe", { headers: { cookie } });
    expect(probeRes.status).toBe(200);
    const body = (await probeRes.json()) as {
      ok: boolean;
      workspace_id: string;
      has_dispatcher: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
    expect(body.has_dispatcher).toBe(true);
  });

  it("principal middleware returns 401 when no session cookie is present", async () => {
    const { auth, dispatcher, trunk } = await buildStack();
    trunk.use(
      "/probe",
      createPrincipalMiddleware({
        resolve: (c) => createBetterAuthResolver(auth)(c.req.raw.headers),
      }),
    );
    trunk.use("/probe", createDispatcherMiddleware({ dispatcher }));
    trunk.get("/probe", (c) => c.json({ ok: true }));

    const res = await trunk.request("/probe");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });
});
