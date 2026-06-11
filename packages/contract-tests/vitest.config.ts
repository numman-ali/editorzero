import { defineConfig } from "vitest/config";

/**
 * Standalone config — deliberately NOT `extendVitestConfig` from
 * `vitest.shared.ts`. This package is an assertion harness with no
 * `src/`: every line it executes belongs to another package, each
 * already measured under its own 95/90/95/95 floor. Coverage here
 * would measure the registry/api-server/mcp-server internals a second
 * time against this package's incidental call pattern — noise, not
 * signal — so it stays off.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
