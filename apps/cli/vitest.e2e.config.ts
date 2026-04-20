/**
 * Separate vitest config for the CLI `*.e2e.test.ts` suite.
 *
 * The e2e test compiles a real `bun build --compile` binary and spawns
 * it as a subprocess, which (a) takes ~5–10s for the compile step
 * alone and (b) produces no v8 coverage for the subprocess's
 * execution (v8 only instruments the host test process). Bundling
 * those tests into the default `pnpm -C apps/cli test` run would
 * both slow every commit *and* drag coverage percentages down. This
 * file is invoked separately via `pnpm -C apps/cli test:e2e` and is
 * wired into the pre-push `e2e` lane in `lefthook.yml`.
 *
 * No coverage reporter, no threshold — the point of the e2e is the
 * end-to-end behavioural assertion, not line coverage.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.test.ts"],
    // The bun-compile + server-boot + multi-spawn roundtrip needs
    // more time than the 5s vitest default for a single test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
