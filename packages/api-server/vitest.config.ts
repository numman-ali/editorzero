import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      // `env.ts` is pure type declarations (the shared `ApiEnv` +
      // `ApiEnvVariables` interfaces). Compiles to zero JS so v8 can't
      // measure it; excluding keeps the totals honest instead of
      // hard-coding a 0% drag.
      exclude: ["src/env.ts"],
    },
  },
});
