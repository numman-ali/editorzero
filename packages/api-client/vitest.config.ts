import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      exclude: [
        // Type-only materialization seam. Its public surface is `export type
        // ApiClient`; the lone `const _client = hc("")` exists only to force
        // tsc to resolve the client type once at build and emit it
        // (ADR 0028, the materialized precompile). Nothing imports it at
        // runtime — the type is
        // consumed via `import type` — so v8 measures the file as 0% with no
        // behavior to test. Excluded per vitest.shared.ts type-only guidance.
        "src/client-type.ts",
      ],
    },
  },
});
