import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { TRUNK_ORIGIN, TRUNK_PORT, WEB_ORIGIN, WEB_PORT } from "./test/servers";

/**
 * Web UI e2e harness (ADR 0033; verification stack step 7). Two real
 * servers, one browser origin:
 *
 *  - **trunk** — `apps/server` bundled from source (see
 *    `scripts/bundle-trunk.mjs`) and run under plain `node` against a
 *    fresh SQLite file per run. `getApiApp` self-migrates on boot.
 *  - **web** — the apps/app Vite dev server, reverse-proxying the
 *    `RESERVED_API_PREFIXES` to the trunk (vite.config.ts honours
 *    `EDITORZERO_TRUNK_ORIGIN`).
 *
 * `EDITORZERO_PUBLIC_ORIGIN` is set to the *Vite* origin — the one the
 * browser actually sees — so Better Auth's `trustedOrigins` check runs
 * against a real cross-process Origin header exactly as in production
 * (ADR 0030's single-origin cookie model). Ports are non-default so a
 * developer's running dev session never collides with the lane.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

/** Test-only Better Auth secret (≥ 32 bytes). Never a real credential. */
const E2E_BETTER_AUTH_SECRET = "editorzero-e2e-only-better-auth-secret";

export default defineConfig({
  testDir: "./test",
  // One worker, no parallelism: the specs share one trunk + one SQLite
  // file, and the auth specs are order-dependent (sign-up provisions the
  // account the sign-in specs use).
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    baseURL: WEB_ORIGIN,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Fresh artifact + fresh DB every run: wipe tmp/, rebundle, boot.
      command: "rm -rf tmp && node scripts/bundle-trunk.mjs && node tmp/server.mjs",
      url: `${TRUNK_ORIGIN}/infra/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: path.join(here, "tmp/e2e.sqlite"),
        PORT: String(TRUNK_PORT),
        EDITORZERO_PUBLIC_ORIGIN: WEB_ORIGIN,
        BETTER_AUTH_SECRET: E2E_BETTER_AUTH_SECRET,
      },
    },
    {
      command: `pnpm -C ${path.join(here, "../../apps/app")} exec vite dev --port ${WEB_PORT} --strictPort`,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        EDITORZERO_TRUNK_ORIGIN: TRUNK_ORIGIN,
      },
    },
  ],
});
