/**
 * Trunk-owned URL prefixes (ADR 0035 §2; SSOT since the static-attach
 * slice).
 *
 * The SPA shares one origin with the API, so this single list is the
 * contract between consumers that must never disagree:
 *
 *   1. the dev Vite proxy (`apps/app/vite.config.ts`) forwards these
 *      prefixes to the trunk, preserving ADR 0030's same-origin
 *      `SameSite=Lax` / no-CORS model in dev exactly as in production;
 *   2. client routes must never collide with them — a SPA route at
 *      `/docs` would shadow the API namespace and is forbidden;
 *   3. the production trunk's SPA fallback (`apps/server`, ADR 0027)
 *      serves `index.html` for non-reserved GETs only — a reserved path
 *      that matches no API route must stay a JSON 404, never the shell;
 *   4. the PWA service-worker denylist derives from this list when ADR
 *      0039 lands (with its security-relevant drift test).
 *
 * One list, imported by all four, so none can drift. It lives in
 * `@editorzero/constants` because the consumers span a browser app and
 * the node server — neither may import the other.
 *
 * **Keep this module import-free.** `apps/app/vite.config.ts` loads it
 * under plain node ESM via the `@editorzero/constants/reserved-prefixes`
 * subpath at config-eval time — the repo's `module: Preserve` dists keep
 * extensionless relative imports, which node cannot resolve, so any
 * internal import added here breaks the Vite config (and with it the
 * dev loop + e2e lane).
 *
 * This module stays hand-written (it must remain import-free, so it
 * cannot import the registry), but it can no longer drift from the
 * trunk: `packages/contract-tests` asserts every registry-derived HTTP
 * binding falls under one of these prefixes, so landing a new route
 * domain without its entry here fails the build. That gate exists
 * because the drift HAPPENED — `/permissions` (Step-8 slice 1) and
 * `/spaces` (slice 2a) landed as trunk domains without joining this
 * list (the ADR 0040 vocabulary-lock section explicitly called both
 * "additive to that SSOT + its equality test"), leaving the dev proxy
 * blind to them, the SPA fallback serving shell HTML for their
 * unmatched GETs, and the SW denylist passing their navigations to the
 * app-shell cache. The gate's first run then exposed a third, older
 * instance: this list said `/audit` while the trunk has always mounted
 * the domain at `/audits` — a dead entry shadowing a missing one. All
 * three fixed 2026-06-12.
 */

export const RESERVED_API_PREFIXES = [
  "/infra",
  "/docs",
  "/collections",
  "/workspaces",
  "/audits",
  "/permissions",
  "/spaces",
  "/auth",
  "/mcp",
  "/collab",
] as const;

export type ReservedApiPrefix = (typeof RESERVED_API_PREFIXES)[number];

/**
 * True when `path` falls under a trunk-owned prefix — either the prefix exactly
 * (`/docs`) or a child of it (`/docs/123`). A path that merely *starts with* the
 * letters (`/documentation`) is not a match: the boundary is a `/` or end-of-string.
 */
export function isReservedApiPath(path: string): boolean {
  return RESERVED_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
