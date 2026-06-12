import { extendVitestConfig } from "../../vitest.shared";

export default extendVitestConfig({
  test: {
    coverage: {
      // React render entry points + the file-based route components + the
      // presentational shell components are exercised by the Playwright + axe
      // e2e lane (ADR 0033), not by vitest unit coverage; `routeTree.gen.ts` is
      // generated; `src/sw.ts` is the service worker — browser-runtime workbox
      // wiring proven end-to-end by the pwa e2e spec (its decision logic lives
      // unit-tested in `src/lib/sw-denylist.ts`). Non-UI logic under
      // `src/lib/**` (incl. the shell's display derivations, e.g.
      // `principal.ts`/`auth-guard.ts`) stays measured against the shared floor.
      exclude: [
        "src/main.tsx",
        "src/routes/**",
        "src/components/**",
        "src/routeTree.gen.ts",
        "src/sw.ts",
      ],
    },
  },
});
