import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      // Type-only modules — discriminated unions / interfaces that compile
      // to zero JS, so v8 measures them at 0% and drags the totals without
      // reflecting a real test gap (vitest.shared type-only guidance).
      // `state.ts` and `reducer.ts` carry the runtime (projection + reducer)
      // and are NOT excluded — the unit test exercises them.
      exclude: ["src/effect.ts", "src/types.ts", "src/writer.ts"],
    },
  },
});
