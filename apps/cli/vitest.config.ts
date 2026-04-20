import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    // End-to-end binary-spawn tests live in a separate suite so they
    // can run in the pre-push lane only — see `vitest.e2e.config.ts`
    // + the `test:e2e` script in `package.json`. The default include
    // (`src/**/*.{test,spec}.ts`) would otherwise pick them up and
    // bolt a ~10s `bun build --compile` step onto every commit.
    exclude: ["**/*.e2e.test.ts", "**/node_modules/**", "**/dist/**"],
    coverage: {
      exclude: [
        // citty command wrappers — pure wiring over the `runX` functions
        // that *are* tested. Excluded to keep coverage honest rather than
        // marking individual `defineCommand({ ... })` branches with
        // v8-ignore pragmas.
        "src/index.ts",
        "src/auth/index.ts",
        // Registry is a one-line `createRegistry([...])` manifest — no
        // logic, and running `registry.list()` through every test would
        // drag unrelated capabilities into each unit suite.
        "src/registry.ts",
        // e2e harness lives under `src/e2e/` and is covered by the
        // separate pre-push lane; excluding keeps v8's threshold
        // counting only the source the in-process suite exercises.
        "src/e2e/**",
      ],
    },
  },
});
