/**
 * `getApiApp` composition-root integration test.
 *
 * Proves the extracted boot path wires the full stack the same way the
 * hand-rolled `buildStack` test helpers do: a real Better Auth instance
 * (+ migrations) on a real SQLite driver, the dispatcher + embedded sync,
 * the principal chain, and a dependency-ordered shutdown. The capability
 * round-trip (sign up → sign in → create a doc) is the end-to-end proof
 * that principal + dispatcher + sync + audit are all live.
 */

import { parseRuntimeConfig, type RuntimeConfig } from "@editorzero/config";
import { createSqliteDriver } from "@editorzero/db";
import { afterEach, describe, expect, it } from "vitest";

import { type BootedApp, getApiApp } from "./server";

// ≥32 bytes of (non-secret, test-only) entropy — Better Auth requires it.
const TEST_SECRET = "test-secret-do-not-use-in-production-getapiapp";

const MEMORY_CONFIG: RuntimeConfig = parseRuntimeConfig({
  EDITORZERO_PUBLIC_ORIGIN: "http://localhost:3000",
  DATABASE_URL: ":memory:",
});

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie
    .split(/,(?=\s*[^ ;]+=)/u)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}

describe("getApiApp", () => {
  let booted: BootedApp | undefined;

  afterEach(async () => {
    if (booted !== undefined) {
      await booted.close();
      booted = undefined;
    }
  });

  it("boots a working trunk: health + auth + capability round-trip", async () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    booted = await getApiApp({
      config: MEMORY_CONFIG,
      secret: TEST_SECRET,
      driver,
      mcpServerInfo: { name: "editorzero-test", version: "9.9.9" },
    });
    const { app } = booted;

    // Public liveness probe.
    const health = await app.request("/infra/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });

    // Better Auth sign-up mints the user + workspace (the user-create
    // hook writes our `workspaces` / `workspace_members` rows — proving
    // ensureSchema ran before auth).
    const signup = await app.request("/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "boot@example.com",
        password: "correct-horse-battery",
        name: "Boot User",
      }),
    });
    expect(signup.status).toBe(200);

    const signin = await app.request("/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "boot@example.com", password: "correct-horse-battery" }),
    });
    expect(signin.status).toBe(200);
    const cookie = sessionCookieFrom(signin);
    expect(cookie.length).toBeGreaterThan(0);

    // Capability round-trip: principal middleware resolves the cookie,
    // the dispatcher invokes doc.create, sync persists the initial doc.
    const create = await app.request("/docs/create", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "Booted doc" }),
    });
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ doc_id: expect.any(String) });
  });

  it("close() is idempotent", async () => {
    const driver = createSqliteDriver({ path: ":memory:" });
    booted = await getApiApp({ config: MEMORY_CONFIG, secret: TEST_SECRET, driver });
    await booted.close();
    // A second close must not throw (the driver is already shut down).
    await expect(booted.close()).resolves.toBeUndefined();
    booted = undefined; // already closed; skip afterEach double-close
  });

  it("boots from the process environment when no options are given", async () => {
    // The vars getApiApp()'s no-options path reads (loadEnvConfig +
    // resolveSecretRef). Held in variables, not literal subscripts: dot
    // access trips TS's index-signature rule while `env["LITERAL"]` trips
    // Biome's useLiteralKeys — a variable key satisfies both. Save/restore
    // around the mutation keeps the suite hermetic.
    const DB_URL = "DATABASE_URL";
    const ORIGIN = "EDITORZERO_PUBLIC_ORIGIN";
    const SECRET = "BETTER_AUTH_SECRET";
    const saved = {
      url: process.env[DB_URL],
      origin: process.env[ORIGIN],
      secret: process.env[SECRET],
    };
    process.env[DB_URL] = ":memory:";
    process.env[ORIGIN] = "http://localhost:3000";
    process.env[SECRET] = TEST_SECRET;
    try {
      booted = await getApiApp();
      const health = await booted.app.request("/infra/health");
      expect(health.status).toBe(200);
    } finally {
      restoreEnv(DB_URL, saved.url);
      restoreEnv(ORIGIN, saved.origin);
      restoreEnv(SECRET, saved.secret);
    }
  });

  it("rejects a Postgres DATABASE_URL (SQLite-only composition root)", async () => {
    const pgConfig = parseRuntimeConfig({
      EDITORZERO_PUBLIC_ORIGIN: "http://localhost:3000",
      DATABASE_URL: "postgresql://localhost:5432/ez",
    });
    await expect(getApiApp({ config: pgConfig, secret: TEST_SECRET })).rejects.toThrow(
      /SQLite-only/,
    );
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
