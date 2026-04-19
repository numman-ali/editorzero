/**
 * `@editorzero/auth` — public barrel.
 *
 * Owns the Better Auth instance factory + principal resolver adapter
 * + programmatic migration helper (ADR 0010 / ADR 0016).
 *
 * Consumers:
 *
 *   - `@editorzero/api-server` creates one `Auth` at trunk
 *     composition time, mounts `auth.handler` on `/auth/*`, and
 *     passes `createBetterAuthResolver(auth)` to
 *     `createPrincipalMiddleware({ resolve })`.
 *   - Test harnesses use `runAuthMigrations(auth)` to bootstrap an
 *     in-memory SQLite DB with Better Auth's core tables.
 */

export type { Auth, CreateAuthOptions } from "./create-auth";
export { createAuth } from "./create-auth";
export { runAuthMigrations } from "./migrate";
export type { BetterAuthResolver } from "./resolver";
export { createBetterAuthResolver } from "./resolver";
