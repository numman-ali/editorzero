/**
 * Integration-lane Vitest config for `@editorzero/db` — dual-dialect
 * conformance harness (ADR 0023 §4).
 *
 * Scoped to `test/integration/**\/*.test.ts`. Invoked via
 * `pnpm -C packages/db test:integration`, which lefthook's pre-push
 * `integration` gate runs when the suite exists.
 *
 * No coverage: integration tests here exist to prove cross-dialect
 * behavioural conformance, not to hit line-level coverage targets.
 * The unit lane (`vitest.config.ts`) owns the 95/90 coverage floor.
 *
 * `testTimeout` is raised — a cold Postgres container pull + start
 * can take 30–60s the first time the image is fetched locally.
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    // Integration tests may spin a Postgres container in beforeAll.
    // Pre-pulled images start in ~3s; cold pulls of 17.4-bookworm on a
    // fresh CI or developer machine have been observed near 60s.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: [
      {
        find: /^@editorzero\/([^/]+)$/,
        replacement: `${ROOT}packages/$1/src/index.ts`,
      },
    ],
  },
});
