// The SUBPATH import is load-bearing: Vite externalizes bare specifiers in
// the config bundle, so plain node ESM loads this module at config-eval —
// the package root's `dist/index.js` re-export chain is extensionless
// (`module: Preserve`) and unloadable under node, while this leaf module
// has no internal imports and loads clean. Keep `reserved-prefixes.ts`
// import-free or this breaks again.
import { RESERVED_API_PREFIXES } from "@editorzero/constants/reserved-prefixes";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

/**
 * Dev loop (ADR 0035 §2): the browser only ever talks to the Vite origin, and
 * Vite reverse-proxies the trunk-owned prefixes to the API server. Because the
 * browser sees a single origin, ADR 0030's `SameSite=Lax` / no-CORS cookie
 * model holds in dev exactly as in production — no dev-only CSRF special-casing.
 *
 * The proxy targets are derived from `RESERVED_API_PREFIXES` in
 * `@editorzero/constants` — the same SSOT the client-route guard and the
 * production trunk's SPA fallback read, so the three can never drift.
 * (Resolves through the package's built `dist/`; `pnpm build` first on a
 * fresh tree, same as every workspace import.)
 */
// Overridable so the e2e harness (packages/e2e) can point the proxy at its
// own trunk on a non-default port. Build-tool config, not a secret — the
// `packages/config` secrets rule governs runtime credential loads.
const { EDITORZERO_TRUNK_ORIGIN } = process.env;
const TRUNK_ORIGIN = EDITORZERO_TRUNK_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  // `tanstackRouter` MUST precede `react()` (load-bearing per the plugin docs,
  // ADR 0035 §4): it codegens `src/routeTree.gen.ts` from `src/routes/**` and
  // applies the auto-code-splitting transform before React Fast Refresh runs.
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  server: {
    proxy: Object.fromEntries(
      RESERVED_API_PREFIXES.map((prefix) => [
        prefix,
        // `/collab` is the Hocuspocus WebSocket upgrade (ADR 0027/0030).
        { target: TRUNK_ORIGIN, ws: prefix === "/collab" },
      ]),
    ),
  },
});
