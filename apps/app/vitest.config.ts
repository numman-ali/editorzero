import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      // React render entry points + the file-based route components are
      // exercised by the Playwright + axe e2e lane (ADR 0033), not by vitest
      // unit coverage; `routeTree.gen.ts` is generated. Non-UI logic under
      // `src/lib/**` stays measured against the shared floor.
      exclude: ["src/main.tsx", "src/routes/**", "src/routeTree.gen.ts"],
    },
  },
});
