#!/usr/bin/env node
/**
 * `editorzero-server` — production boot entrypoint (ADR 0027 / 0029 §8).
 *
 * The thinnest glue over the tested pieces: load runtime config, build
 * the full stack via `getApiApp`, bind it with `startServer`, and turn
 * `SIGTERM` / `SIGINT` into a graceful `RunningServer.close()` (drain →
 * stack teardown) before exit. All lifecycle logic lives in `./runtime`
 * and `getApiApp` (both tested); this file is process wiring + structured
 * boot/shutdown logging, and is excluded from coverage (see
 * `vitest.config.ts`, mirroring apps/cli's bin entry).
 *
 * **SQLite single-box floor today** (ADR 0027): one process — the API
 * trunk, SQLite, embedded sync, and (when `EDITORZERO_SPA_DIST` points at
 * a built `apps/app/dist`) the SPA bundle via `attachSpa`. The `/collab`
 * WebSocket upgrade stays unmounted — production WS attach is gated on
 * the ADR 0030 red-team blockers (task #15).
 */

import { getApiApp } from "@editorzero/api-server";
import { loadEnvConfig } from "@editorzero/config";
import { consoleLogger } from "@editorzero/observability";

import { startServer } from "./runtime";
import { attachSpa } from "./spa";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const log = consoleLogger();
  const config = loadEnvConfig();
  const booted = await getApiApp({ config });
  if (config.spa_dist !== undefined) {
    attachSpa(booted.app, config.spa_dist);
  }
  const running = await startServer(booted, config.port);
  log.info("server listening", {
    event: "server.listening",
    "server.port": running.port,
    "server.origin": config.public_origin,
    "server.spa_dist": config.spa_dist ?? "(none)",
  });

  let draining = false;
  const drain = (signal: NodeJS.Signals): void => {
    if (draining) return;
    draining = true;
    log.info("server draining", { event: "server.draining", "server.signal": signal });
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error("server drain failed", {
          event: "server.boot_failed",
          "server.error": describeError(error),
        });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", drain);
  process.on("SIGINT", drain);
}

main().catch((error: unknown) => {
  consoleLogger().error("server boot failed", {
    event: "server.boot_failed",
    "server.error": describeError(error),
  });
  process.exitCode = 1;
});
