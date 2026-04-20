import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      exclude: [
        // citty command wrappers — pure wiring over the `runX` functions
        // that *are* tested. Excluded to keep coverage honest rather than
        // marking individual `defineCommand({ ... })` branches with
        // v8-ignore pragmas.
        "src/index.ts",
        "src/auth/index.ts",
      ],
    },
  },
});
