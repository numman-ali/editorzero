/**
 * Slow-lane Vitest config — property / crash-fuzz suites only.
 *
 * Scoped to `packages/*\/prop/**\/*.test.ts`. Kept in a separate file
 * (rather than a `projects` entry in the root `vitest.config.ts`) so
 * that the default `pnpm test` / `pnpm test:watch` at the repo root
 * never pull this lane into the fast developer loop. Prop suites run
 * only when explicitly invoked: `pnpm test:prop` (= `vitest run
 * --config vitest.prop.config.ts`) or via `lefthook.yml`'s pre-push
 * `property` hook.
 *
 * `resolve.alias` rewires `@editorzero/<pkg>` to each package's
 * `src/index.ts` so the lane always exercises the current source tree
 * rather than resolving through `exports` → `dist/index.js`. Without it
 * this suite could silently validate stale compiled artifacts on a
 * working tree whose TypeScript hadn't been rebuilt — and the pre-push
 * `property` gate relies on this config catching exactly those
 * regressions. The unit lane (`vitest.config.ts`) uses the same alias
 * for the same reason.
 *
 * See `vitest.config.ts` (fast lane) and `AGENTS.md` § Verification
 * stack for the rationale behind the fast / slow split.
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/prop/**/*.test.ts"],
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
