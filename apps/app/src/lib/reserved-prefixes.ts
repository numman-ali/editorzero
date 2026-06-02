/**
 * Trunk-owned URL prefixes (ADR 0035 §2).
 *
 * The SPA shares one origin with the API, so this single list is the contract
 * between two consumers that must never disagree:
 *   1. the dev Vite proxy (`vite.config.ts`) forwards these prefixes to the
 *      trunk, preserving ADR 0030's same-origin `SameSite=Lax` / no-CORS model
 *      in dev exactly as in production;
 *   2. client routes must never collide with them — a SPA route at `/docs`
 *      would shadow the API namespace and is forbidden.
 *
 * One list, imported by both, so the proxy and the route guard cannot drift.
 *
 * TODO(registry-derive): ADR 0035 §2 wants this derived from the capability
 * route domains so it cannot drift from the *trunk* either. Hardcoded for the
 * scaffold; a follow-up should source the five capability domains from the
 * registry and keep `/auth`, `/mcp`, `/collab` as the framework-owned tail.
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
