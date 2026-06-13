import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { TRUNK_ORIGIN, TRUNK_PORT, WEB_ORIGIN, WEB_PORT } from "./test/servers";

/**
 * Web UI e2e harness (ADR 0033; verification stack step 7). Two real
 * servers, one browser origin:
 *
 *  - **trunk** — `apps/server` bundled from source (the canonical
 *    `apps/server/scripts/bundle.mjs`, `--out` into this package's tmp/;
 *    `better-sqlite3` stays external and resolves from THIS package's
 *    devDependencies) and run under plain `node` against a fresh SQLite
 *    file per run. `getApiApp` self-migrates on boot.
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
      // Fresh artifact + fresh DB every run: wipe tmp/, rebundle, build the
      // SPA (PWA on — `vite build` is the only mode that emits the service
      // worker + manifest), attach it, boot. The trunk thereby serves the
      // production posture (ADR 0027/0035 static attach), which is what
      // `pwa.spec.ts` runs against — SW registration is a build-only
      // behavior, so it CANNOT be proven on the Vite dev origin below.
      command:
        "rm -rf tmp && node ../../apps/server/scripts/bundle.mjs --out tmp/server.mjs && pnpm -C ../../apps/app exec vite build --outDir ../../packages/e2e/tmp/spa-dist --emptyOutDir && node tmp/server.mjs",
      url: `${TRUNK_ORIGIN}/infra/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: path.join(here, "tmp/e2e.sqlite"),
        PORT: String(TRUNK_PORT),
        EDITORZERO_PUBLIC_ORIGIN: WEB_ORIGIN,
        BETTER_AUTH_SECRET: E2E_BETTER_AUTH_SECRET,
        EDITORZERO_SPA_DIST: path.join(here, "tmp/spa-dist"),
        // This suite is ONE founder user driving dozens of serial specs;
        // each cold-boot navigation fans out session + workspace +
        // collections + the route's own read, which bursts past the
        // 600/min user budget (ADR 0044 increment 6) and 429s a later cold
        // boot into the route error boundary — a synthetic-volume artifact,
        // not a product fault. The limiter's own unit + integration suites
        // prove throttling; here we opt out so UI parity is what's tested.
        EDITORZERO_RATE_LIMIT_DISABLED: "1",
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
