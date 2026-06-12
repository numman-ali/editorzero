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
 * TODO(registry-derive): ADR 0035 §2 wants this derived from the
 * capability route domains so it cannot drift from the *trunk* either.
 * Hardcoded for now; a follow-up should source the five capability
 * domains from the registry and keep `/auth`, `/mcp`, `/collab` as the
 * framework-owned tail.
 */

export const RESERVED_API_PREFIXES = [
  "/infra",
  "/docs",
  "/collections",
  "/workspaces",
  "/audit",
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
