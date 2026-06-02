import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      // React render entry points are exercised by the Playwright + axe e2e
      // lane (ADR 0033), not by vitest unit coverage. Non-UI logic under
      // `src/lib/**` stays measured against the shared floor.
      exclude: ["src/main.tsx", "src/App.tsx"],
    },
  },
});
