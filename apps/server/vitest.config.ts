import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      exclude: [
        // Bin entrypoint — process wiring (loadEnvConfig → getApiApp →
        // startServer + SIGTERM/SIGINT handlers + structured boot logging)
        // over the `runtime.ts` lifecycle and `getApiApp`, both of which
        // *are* tested. Excluded to keep coverage honest rather than
        // pragma-marking the signal-handler branches (mirrors apps/cli).
        "src/index.ts",
      ],
    },
  },
});
