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
 * trunk, SQLite, embedded sync, the `/collab` WebSocket upgrade via
 * `attachCollab` (ADR 0030 hardening: Origin allow-list, cookie authN at
 * upgrade, per-document authZ + forced readOnly per Auth frame inside the
 * shared Hocuspocus), and (when `EDITORZERO_SPA_DIST` points at a built
 * `apps/app/dist`) the SPA bundle via `attachSpa`.
 */

import { getApiApp, PERMISSIVE_RATE_LIMITER } from "@editorzero/api-server";
import { loadEnvConfig } from "@editorzero/config";
import { consoleLogger } from "@editorzero/observability";

import { attachCollab } from "./collab";
import { startServer } from "./runtime";
import { attachSpa } from "./spa";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const log = consoleLogger();
  const config = loadEnvConfig();
  if (config.rate_limit_disabled) {
    // Loud on purpose: invariant 8 promises ENFORCED limits, so a
    // disabled limiter in a real deployment is a misconfiguration an
    // operator must see at boot (the only sanctioned use is the e2e
    // suite's synthetic request volume — see the config field docs).
    log.warn("rate limiting DISABLED via EDITORZERO_RATE_LIMIT_DISABLED", {
      event: "server.rate_limit_disabled",
    });
  }
  const booted = await getApiApp({
    config,
    logger: log,
    // The wrap still runs; this limiter just always allows. Opt out ONLY
    // when explicitly configured — never the production default.
    ...(config.rate_limit_disabled && { rateLimiter: PERMISSIVE_RATE_LIMITER }),
  });
  if (config.spa_dist !== undefined) {
    attachSpa(booted.app, config.spa_dist);
  }
  const running = await startServer(booted, config.port, [
    (server) => attachCollab(server, booted, { publicOrigin: config.public_origin, logger: log }),
  ]);
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
