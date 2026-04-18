/**
 * Shared vitest base config — imported by per-package `vitest.config.ts`.
 *
 * The 95/90 threshold is the project-wide floor. Packages that can't
 * realistically hit it (type-heavy barrels, files with many genuinely
 * unreachable defensive branches) should not lower the threshold —
 * they should either exclude the file or mark the unreachable branches
 * with a `v8 ignore` pragma (see https://vitest.dev/config/coverage —
 * the pragma requires a `-- @preserve` suffix so esbuild keeps it) so
 * the intent is auditable in the diff rather than buried in config.
 */

import { defineConfig, mergeConfig, type UserConfig } from "vitest/config";

export const sharedVitestConfig: UserConfig = defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/*.d.ts",
        // Barrel files are re-exports; covered transitively by tests
        // that exercise the re-exported members.
        "src/index.ts",
        // Type-only modules (interfaces, discriminated unions, zero
        // runtime). v8 can only measure what compiles to JS; these
        // files compile to nothing, so they'd show 0% and drag the
        // totals down without reflecting any real test gap. Packages
        // list their type-only modules here via the `extendVitestConfig`
        // override.
      ],
      // `all: true` makes uncovered source files count against the
      // threshold. Without it, coverage only counts imported files —
      // a new un-tested module would silently pass.
      all: true,
      // Project-wide floor. Raise per-package via `extendVitestConfig`
      // when justified; never lower.
      thresholds: {
        lines: 95,
        branches: 90,
        functions: 95,
        statements: 95,
      },
    },
  },
});

export function extendVitestConfig(overrides: UserConfig): UserConfig {
  return mergeConfig(sharedVitestConfig, overrides);
}
