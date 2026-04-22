/**
 * `@editorzero/auth` integration test — full auth chain against a
 * real in-memory SQLite driver.
 *
 * Exercises the contract every downstream consumer depends on:
 *
 *   1. `createAuth({ driver, ... })` produces a functioning Better
 *      Auth instance against our shared `SqliteDriver`.
 *   2. `runAuthMigrations(auth)` bootstraps the `user`, `session`,
 *      `account`, `verification` tables into the already-populated
 *      editorzero schema without conflict.
 *   3. `auth.api.signUpEmail` fires the `databaseHooks.user.create.
 *      before` hook that mints `workspaceId` server-side.
 *   4. `auth.api.signInEmail` returns a session cookie.
 *   5. `createBetterAuthResolver(auth)` resolves that cookie into a
 *      `UserPrincipal` with the minted `workspace_id`.
 *
 * If any link in this chain breaks, every downstream capability
 * route that relies on authenticated sessions breaks with it — so
 * this integration test is a canary for the whole api-server auth
 * stack.
 */

import {
  createLoadRoles,
  createSqliteDriver,
  type LoadRoles,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "./create-auth";
import { runAuthMigrations } from "./migrate";
import { createBetterAuthResolver } from "./resolver";

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

function buildAuth() {
  return createAuth({
    driver,
    baseURL: "http://localhost:3000",
    // 32-byte secret for tests — production gets this from
    // `packages/config/secrets.ts`.
    secret: "test-secret-do-not-use-in-production-at-all",
    trustedOrigins: ["http://localhost:3000"],
  });
}

/**
 * Extract the session cookie from a Better Auth response's
 * `Set-Cookie` headers. Returns a `Cookie:`-style header string
 * suitable for echoing back on subsequent requests.
 */
function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  // Better Auth's session cookie has a name like
  // `better-auth.session_token`. Grab everything up to the first `;`
  // of each cookie-definition and join with `; `.
  return setCookie
    .split(/,(?=\s*[^ ;]+=)/u) // split on commas that precede a new cookie definition
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}

describe("@editorzero/auth", () => {
  it("runAuthMigrations bootstraps Better Auth tables onto the shared DB", async () => {
    const auth = buildAuth();
    await runAuthMigrations(auth);

    // Confirm Better Auth's core tables now exist alongside ours.
    const tables = await driver
      .system()
      // biome-ignore lint/suspicious/noExplicitAny: sqlite_master is a system table outside our Database type.
      .selectFrom("sqlite_master" as any)
      .select("name" as never)
      .where("type" as never, "=", "table" as never)
      .execute();
    const names = new Set((tables as { name: string }[]).map((t) => t.name));
    expect(names.has("user")).toBe(true);
    expect(names.has("session")).toBe(true);
    expect(names.has("account")).toBe(true);
    expect(names.has("verification")).toBe(true);
    // And our tables are still there.
    expect(names.has("docs")).toBe(true);
    expect(names.has("audit_events")).toBe(true);
  });

  it("sign-up mints workspaceId via the databaseHooks.user.create.before hook", async () => {
    const auth = buildAuth();
    await runAuthMigrations(auth);

    await auth.api.signUpEmail({
      body: {
        email: "alice@example.com",
        password: "correct-horse-battery-staple",
        name: "Alice",
      },
    });

    const users = await driver
      .system()
      // biome-ignore lint/suspicious/noExplicitAny: user table is Better Auth's, outside our Database type.
      .selectFrom("user" as any)
      .select(["id" as never, "email" as never, "workspaceId" as never])
      .execute();
    expect(users).toHaveLength(1);
    const user = users[0] as { id: string; email: string; workspaceId: string };
    expect(user.email).toBe("alice@example.com");
    // Hook populated a UUIDv7-shaped WorkspaceId.
    expect(user.workspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
  });

  it("sign-in → resolver → UserPrincipal round-trip (role sourced from workspace_members by signup-bootstrap hook)", async () => {
    // ADR 0024: the `user.create.after` bootstrap hook in
    // `create-auth.ts` inserts a `workspaces` row (tenant-scope
    // anchor) and a `workspace_members` row (role: "owner")
    // post-commit, so the resolver can immediately source the role
    // from there without any separate backfill migration. This test
    // exercises the end-to-end path — signup through BA, which fires
    // the hook, which seeds both rows, which the resolver reads at
    // principal resolution.
    const auth = buildAuth();
    await runAuthMigrations(auth);

    await auth.api.signUpEmail({
      body: {
        email: "bob@example.com",
        password: "correct-horse-battery-staple",
        name: "Bob",
      },
    });

    // Confirm the hook populated the `workspaces` anchor row. Slug
    // is `{local-part}-{6-hex}`; display name is `{local-part}'s
    // workspace`; diagnostic_salt is 16 random bytes; defaults from
    // the DDL land for trash_retention_days (30) and settings ('{}').
    const workspaceRow = await driver
      .system()
      .selectFrom("workspaces")
      .select(["slug", "name", "trash_retention_days", "diagnostic_salt", "settings"])
      .executeTakeFirstOrThrow();
    expect(workspaceRow.slug).toMatch(/^bob-[0-9a-f]{6}$/u);
    expect(workspaceRow.name).toBe("bob's workspace");
    expect(workspaceRow.trash_retention_days).toBe(30);
    expect(workspaceRow.diagnostic_salt.byteLength).toBe(16);
    expect(workspaceRow.settings).toBe("{}");

    // Confirm the hook populated the membership row. The role is
    // `"owner"` because a fresh signup mints a fresh workspace and
    // the signing-up user owns it by construction.
    const memberRow = await driver
      .system()
      .selectFrom("workspace_members")
      .select(["role", "deleted_at"])
      .executeTakeFirstOrThrow();
    expect(memberRow.role).toBe("owner");
    expect(memberRow.deleted_at).toBeNull();

    const signInResponse = await auth.api.signInEmail({
      body: {
        email: "bob@example.com",
        password: "correct-horse-battery-staple",
      },
      asResponse: true,
    });
    expect(signInResponse.status).toBe(200);

    const cookieHeader = sessionCookieFrom(signInResponse);
    expect(cookieHeader.length).toBeGreaterThan(0);

    const resolver = createBetterAuthResolver({ auth, loadRoles: createLoadRoles(driver) });
    const headers = new Headers({ cookie: cookieHeader });
    const principal = await resolver(headers);

    expect(principal).not.toBeNull();
    if (principal === null) throw new Error("unreachable — principal checked above");
    expect(principal.kind).toBe("user");
    expect(principal.roles).toEqual(["owner"]);
    expect(principal.token_id).toBeNull();
    expect(principal.session_id).not.toBeNull();
    expect(principal.workspace_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);
  });

  it("resolver returns null when the session is valid but no workspace_members row exists (ADR 0024 strict-on-missing)", async () => {
    // Post-ADR 0024 the membership table is authoritative; a signed-
    // in user without a `workspace_members` row is structurally
    // invalid. Production can't normally hit this branch: the
    // `user.create.after` hook in `create-auth.ts` seeds the row
    // post-commit on every signup and hook errors propagate as
    // signup failures (fail-loud, not atomic). But a future
    // partial-failure of that hook, an ADR 0017 cascade that
    // soft-deleted the row, or a migration gap could all produce a
    // signed-in user without an active membership row. The resolver
    // must refuse to mint an unprivileged principal by falling back;
    // it returns null → 401.
    //
    // To exercise this branch in isolation we delete the hook-seeded
    // row after signup, then resolve. The assertion pins the strict
    // contract regardless of how the row went missing.
    const auth = buildAuth();
    await runAuthMigrations(auth);

    await auth.api.signUpEmail({
      body: {
        email: "dora@example.com",
        password: "correct-horse-battery-staple",
        name: "Dora",
      },
    });
    // Simulate the "membership row went missing" state the resolver
    // must handle. Hard-delete is fine — the resolver already
    // filters `deleted_at IS NULL`, so a soft-delete would exercise
    // the same branch.
    await driver.system().deleteFrom("workspace_members").execute();

    const signInResponse = await auth.api.signInEmail({
      body: {
        email: "dora@example.com",
        password: "correct-horse-battery-staple",
      },
      asResponse: true,
    });
    const cookieHeader = sessionCookieFrom(signInResponse);

    const resolver = createBetterAuthResolver({ auth, loadRoles: createLoadRoles(driver) });
    const principal = await resolver(new Headers({ cookie: cookieHeader }));
    expect(principal).toBeNull();
  });

  it("resolver returns null for requests without a session cookie", async () => {
    // loadRoles is unreachable on this branch — getSession returns
    // null first. A never-called stub verifies that invariant.
    const auth = buildAuth();
    await runAuthMigrations(auth);

    const loadRoles: LoadRoles = async () => {
      throw new Error("loadRoles must not be called when session is null");
    };
    const resolver = createBetterAuthResolver({ auth, loadRoles });
    const principal = await resolver(new Headers());
    expect(principal).toBeNull();
  });

  it("createAuth accepts omitted trustedOrigins (same-origin deploys)", async () => {
    // Covers the `trustedOrigins !== undefined` branch in the
    // factory. Same-origin deploys legitimately omit it.
    const auth = createAuth({
      driver,
      baseURL: "http://localhost:3000",
      secret: "test-secret-do-not-use-in-production-at-all",
    });
    await runAuthMigrations(auth);
    // Sanity: instance exposes the same session API.
    expect(typeof auth.api.signUpEmail).toBe("function");
  });

  it("resolver returns null when the user row is missing workspaceId (bootstrap edge case)", async () => {
    // Simulates the pre-hook-bootstrap edge case: a user row exists
    // without workspaceId (e.g. inserted before the databaseHook was
    // wired, or by a migration). ADR 0016 requires every
    // UserPrincipal carry a workspace_id — so the resolver must
    // refuse to mint an invalid principal rather than silently
    // substituting a placeholder. We inject the invalid row
    // directly, then bypass signin by forging a session row for
    // that user and confirming the resolver sees the cookie as
    // null-worthy.
    const auth = buildAuth();
    await runAuthMigrations(auth);

    // Sign up normally, then zero out the workspaceId on the row.
    await auth.api.signUpEmail({
      body: {
        email: "charlie@example.com",
        password: "correct-horse-battery-staple",
        name: "Charlie",
      },
    });
    await driver
      .system()
      // biome-ignore lint/suspicious/noExplicitAny: user table is Better Auth's.
      .updateTable("user" as any)
      .set({ workspaceId: null } as never)
      .execute();

    // Sign in, grab the cookie, try to resolve → expect null.
    const signInResponse = await auth.api.signInEmail({
      body: {
        email: "charlie@example.com",
        password: "correct-horse-battery-staple",
      },
      asResponse: true,
    });
    const cookieHeader = sessionCookieFrom(signInResponse);
    // loadRoles is unreachable on this branch too — the workspaceId
    // guard in the resolver fires before the membership lookup.
    const loadRoles: LoadRoles = async () => {
      throw new Error("loadRoles must not be called when workspaceId is missing");
    };
    const resolver = createBetterAuthResolver({ auth, loadRoles });
    const principal = await resolver(new Headers({ cookie: cookieHeader }));
    expect(principal).toBeNull();
  });
});
