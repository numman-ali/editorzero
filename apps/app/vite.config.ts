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
import { VitePWA } from "vite-plugin-pwa";

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
  // `VitePWA` comes LAST (ADR 0039 §1) so the precache manifest sees the
  // final emitted assets.
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    // The PWA layer (ADR 0039 §1). `injectManifest` — the hand-authored
    // `src/sw.ts` IS the caching policy, reviewable in one file; never
    // `generateSW`. `registerType: 'prompt'` — never autoUpdate over a
    // live editor. `injectRegister: false` — registration happens in
    // exactly one place (`components/pwa-prompt.tsx`), not an injected
    // script. Dev SW is OFF (`devOptions` default): the dev loop and the
    // dev-origin e2e specs run SW-less; the production posture is proven
    // by `packages/e2e/test/pwa.spec.ts` against the trunk-served build.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: false,
      injectManifest: {
        // The app shell ONLY (ADR 0039): html + every hashed js/css chunk
        // + the three runtime-loaded latin variable fonts + icons. The
        // other @fontsource unicode-range subsets (latin-ext, cyrillic…)
        // stay network-loaded — precaching ~1 MB of subsets nobody
        // renders would bloat install for nothing.
        globPatterns: [
          "**/*.{js,css,html}",
          "**/*latin-wght-normal*.woff2",
          "icons/*.png",
          "manifest.webmanifest",
        ],
      },
      // Meridian Zero (ADR 0036): paper-white field, ink text — the
      // canonical light theme drives the OS-level surfaces. Values
      // mirror `--paper` in styles/meridian-zero.css (the SSOT copy).
      manifest: {
        id: "/",
        name: "editorzero",
        short_name: "editorzero",
        description:
          "Open-source, self-hostable docs and collaboration platform where humans and AI agents are peer co-editors.",
        start_url: "/?source=pwa",
        scope: "/",
        display: "standalone",
        display_override: ["standalone", "minimal-ui"],
        theme_color: "#f4f6f8",
        background_color: "#f4f6f8",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
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
