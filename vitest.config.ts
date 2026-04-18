/**
 * Root Vitest config — default fast-lane scope.
 *
 * The repo splits tests into fast/slow lanes (lefthook.yml, AGENTS.md §
 * Verification stack):
 *
 *   - Fast lane — per-package `pnpm test` / `pnpm test:affected` uses
 *     each package's own `vitest.config.ts` with coverage thresholds.
 *     This root config scopes root-level `pnpm test` / `pnpm test:watch`
 *     to `packages/*\/src/**\/*.{test,spec}.ts` so a single "run all
 *     unit suites" invocation exists without per-package filtering.
 *   - Slow lane — `pnpm test:prop` uses a separate config
 *     (`vitest.prop.config.ts`) scoped to `packages/*\/prop/**\/*.test.ts`.
 *     Keeping them in different configs means `vitest run` at the repo
 *     root never pulls crash-fuzz / property suites into the default
 *     watch cycle — developers who want them run `pnpm test:prop`
 *     (or the pre-push hook does).
 *
 * `resolve.alias` rewires `@editorzero/<pkg>` to each package's
 * `src/index.ts` so cross-package imports (e.g. a test in
 * `packages/sync/src` importing `@editorzero/db`) resolve against the
 * current source tree rather than through `exports` → `dist/index.js`.
 * Without the alias the root lane would silently validate stale
 * compiled artifacts on any working tree whose TypeScript hadn't been
 * rebuilt. `vitest.prop.config.ts` (slow lane) uses the same alias so
 * both lanes behave consistently.
 *
 * New property suites follow the convention: drop the file at
 * `packages/<pkg>/prop/<name>.test.ts`, no further wiring needed.
 * `lefthook.yml`'s pre-push `property` hook activates automatically
 * as soon as any `packages/*\/prop/` directory exists.
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.{test,spec}.ts"],
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
