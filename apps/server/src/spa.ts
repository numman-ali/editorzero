/**
 * Production SPA static attach (ADR 0027 topology / ADR 0035 §2).
 *
 * Mounts the built `apps/app` bundle on the trunk so one process serves
 * the whole product: API routes keep precedence (they were registered
 * first, so a matched route never reaches these handlers), then a file
 * pass over the dist directory, then the SPA fallback that serves
 * `index.html` for client routes (`/login`, `/spaces/…`) so deep links
 * and hard refreshes work.
 *
 * **The reserved-prefix guard is the load-bearing line.** An unmatched
 * path under a trunk-owned prefix (`/docs/nope`, `/workspaces/x/y`) must
 * stay an API-shaped 404 — serving the HTML shell there would turn every
 * API typo into a confusing 200 and break non-browser clients' error
 * handling. The guard reads `RESERVED_API_PREFIXES` from
 * `@editorzero/constants` — the same SSOT the dev Vite proxy and the
 * client-route guard use, so the three surfaces cannot drift (ADR 0035
 * §2). The fallback is GET-only: a POST to a client route is not a
 * navigation and gets the trunk's 404, not HTML.
 *
 * **Caching:** Vite emits content-hashed filenames under `/assets/`, so
 * those are `immutable`; everything else (`index.html`, root-level icons
 * — stable names, changing bytes) is `no-cache` so a deploy is picked up
 * on the next navigation while conditional requests stay cheap. The
 * header is set on the *returned* Response, not via `onFound` +
 * `c.header()`: with hono 4.12.14, `c.header()` after the response is
 * built swaps a NEW Response into the context while `serveStatic`
 * returns the old captured one — the documented `onFound` pattern
 * silently drops the header in this pairing (pinned by the integration
 * test).
 *
 * `serveStatic` (from the pinned `@hono/node-server`) calls `next()` on
 * a miss and rejects `..` traversal segments before touching the fs;
 * absolute `root` paths resolve through plain `path.join` — both pinned
 * by the integration test, since the doc comment upstream is ambiguous
 * about absolute roots.
 *
 * The `/collab` WebSocket upgrade is deliberately NOT mounted here —
 * production WS attach is gated on the ADR 0030 red-team blockers
 * (task #15: role-aware readOnly, Origin check, revocation freshness).
 */

import type { ApiEnv, BootedApp } from "@editorzero/api-server";
import { isReservedApiPath } from "@editorzero/constants";
import { serveStatic } from "@hono/node-server/serve-static";

type TrunkApp = BootedApp["app"];
// Instantiated against the trunk's env so the wrapper's context unifies
// with the typed route chain (`Context<ApiEnv>` is invariant — an
// untyped `serveStatic()` middleware would not accept it).
type StaticMiddleware = ReturnType<typeof serveStatic<ApiEnv>>;

/** `Cache-Control` for a request pathname: hashed assets vs everything else. */
export function cacheControlFor(pathname: string): string {
  return pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

/**
 * Wrap a `serveStatic` middleware so every file hit carries the cache
 * policy. A miss returns `next()`'s (void) result untouched, so the
 * chain continues; a hit returns the file Response with the header set
 * on the actual returned object.
 */
function withCacheControl(inner: StaticMiddleware): StaticMiddleware {
  return async (c, next) => {
    const res = await inner(c, next);
    if (res instanceof Response && res.ok) {
      res.headers.set("Cache-Control", cacheControlFor(c.req.path));
    }
    return res;
  };
}

/**
 * Attach the SPA bundle at `distRoot` (absolute path to `apps/app/dist`)
 * to the booted trunk. Call after `getApiApp` — route registration order
 * is what gives the API precedence.
 */
export function attachSpa(app: TrunkApp, distRoot: string): void {
  // File pass: serves `/` (directory → index.html), `/assets/*`, and any
  // root-level static file (favicon, manifest). Misses call `next()`.
  app.use("*", withCacheControl(serveStatic<ApiEnv>({ root: distRoot })));

  // SPA fallback: client-route GETs get the shell; reserved prefixes fall
  // through to the trunk's own 404/error shape.
  const serveIndex = withCacheControl(serveStatic<ApiEnv>({ root: distRoot, path: "index.html" }));
  app.get("*", (c, next) => {
    if (isReservedApiPath(c.req.path)) return next();
    return serveIndex(c, next);
  });
}
