/**
 * `createPrincipalMiddleware` — principal-resolution seam (ADR 0009,
 * ADR 0016, architecture.md §3.3).
 *
 * Every capability route assumes `c.var.principal` is set by the time
 * the handler runs. This middleware is the *only* code path that sets
 * it. The resolver is injected so the production trunk can plug Better
 * Auth (session cookies, human PATs, agent API keys, agent-auth delegated
 * tokens, remote MCP OAuth bearers → all resolve to the same `Principal`
 * shape) while tests inject a fake.
 *
 * **Why a factory, not a concrete middleware.** Better Auth integration
 * is its own slice (OAuth + session storage + plugin config). Writing
 * the production resolver today would drag that slice into the
 * middleware-machinery slice. The factory shape is the composition
 * seam: the same middleware contract for "produce a Principal or fail
 * with 401" serves both the eventual Better Auth impl and the test
 * fakes capability routes need. When Better Auth lands, a
 * `createBetterAuthResolver(auth)` export ships alongside this factory;
 * callers swap `{ resolve: betterAuthResolver }` in without touching
 * the middleware.
 *
 * **Unauthenticated == 401, not silently pass-through.** A route that
 * mounts this middleware declares it needs a principal; resolver
 * returning `null` is a 401 with a minimal JSON body (no debug info
 * in the error envelope — that's what OTel spans / audit rows are for).
 * Routes that are deliberately public (`/infra/health`) do not mount
 * this middleware; they do not have `c.var.principal` in their typed
 * env.
 *
 * **Contract with the resolver:**
 *
 *   - Sync or async return. `async` covers the Better Auth case where
 *     session resolution hits the DB.
 *   - Returns `Principal | null`. Non-`null` means authenticated.
 *     `null` means unauthenticated → 401. Throwing is for *resolver*
 *     errors (DB timeout, corrupted token) — those should 500, and
 *     the middleware rethrows so Hono's error handler (or an explicit
 *     `app.onError`) projects it.
 *   - Does NOT perform permission checks. The permission gate inside
 *     the dispatcher owns scope / role / workspace checks. The
 *     resolver's job is "is this request authenticated, and who as."
 *
 * **Typing.** Returns `MiddlewareHandler<ApiEnv>` so Hono's `.use(...)`
 * chain + route-level `middleware: [...]` both accept it. The middleware
 * sets `c.var.principal` via `c.set("principal", ...)` and calls `next()`
 * on success; on `null` it short-circuits with `c.json({...}, 401)`
 * without calling `next()`.
 */

import type { Principal } from "@editorzero/principal";
import type { Context, MiddlewareHandler } from "hono";

import type { ApiEnv } from "../env";

export type PrincipalResolver = (
  c: Context<ApiEnv>,
) => Promise<Principal | null> | Principal | null;

export interface PrincipalMiddlewareOptions {
  readonly resolve: PrincipalResolver;
}

export function createPrincipalMiddleware(
  options: PrincipalMiddlewareOptions,
): MiddlewareHandler<ApiEnv> {
  const { resolve } = options;
  return async (c, next) => {
    const principal = await resolve(c);
    if (principal === null) {
      return c.json({ error: "unauthenticated" as const }, 401);
    }
    c.set("principal", principal);
    return next();
  };
}
