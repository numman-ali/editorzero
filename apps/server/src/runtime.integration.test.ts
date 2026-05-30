/**
 * `startServer` lifecycle integration test.
 *
 * Boots a real stack over an in-memory SQLite driver, binds it to an
 * OS-assigned port, and proves: the trunk answers over real TCP, a bind
 * onto an in-use port rejects, and `close()` drains + tears down the
 * stack and is idempotent. The boot path runs `getApiApp` → `createApiApp`
 * → `ensureDomGlobals` (which restores Node's fetch afterward), so the
 * Node `fetch` below reaches the server normally.
 */

import { type BootedApp, getApiApp } from "@editorzero/api-server";
import { parseRuntimeConfig } from "@editorzero/config";
import { afterEach, describe, expect, it } from "vitest";

import { type RunningServer, startServer } from "./runtime";

const TEST_SECRET = "test-secret-do-not-use-in-production-appsserver";

function boot(): Promise<BootedApp> {
  return getApiApp({
    config: parseRuntimeConfig({
      EDITORZERO_PUBLIC_ORIGIN: "http://localhost:3000",
      DATABASE_URL: ":memory:",
    }),
    secret: TEST_SECRET,
  });
}

describe("startServer", () => {
  let running: RunningServer | undefined;
  let booted: BootedApp | undefined;

  afterEach(async () => {
    // `running.close()` tears the booted stack down too; the extra
    // `booted.close()` covers the bind-failure case where `running` never
    // started. Both close paths are idempotent.
    await running?.close();
    await booted?.close();
    running = undefined;
    booted = undefined;
  });

  it("serves the trunk over TCP and resolves the bound port", async () => {
    booted = await boot();
    running = await startServer(booted, 0);
    expect(running.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${running.port}/infra/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  it("close() drains the stack and is idempotent", async () => {
    booted = await boot();
    running = await startServer(booted, 0);
    await running.close();
    // A second close must resolve without throwing (server already down).
    await expect(running.close()).resolves.toBeUndefined();
  });

  it("rejects when the port is already bound", async () => {
    booted = await boot();
    running = await startServer(booted, 0);
    await expect(startServer(booted, running.port)).rejects.toThrow();
  });
});
