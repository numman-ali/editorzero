import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      // `kernel.ts` is pure type declarations (interfaces, discriminated
      // unions for CapabilityContext/Capability/RegisteredCapability). It
      // compiles to zero JS so v8 can't measure it; excluding keeps the
      // totals honest instead of hard-coding a 0% drag.
      exclude: ["src/kernel.ts"],
    },
  },
});
