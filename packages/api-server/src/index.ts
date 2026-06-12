/**
 * `@editorzero/api-server` — public barrel.
 *
 * Exports:
 *
 *   - `createApiApp({ auth, loadRoles, dispatcher, registry? })` —
 *     composition-root factory. Production callers construct one
 *     instance at boot with a Better Auth instance + `loadRoles` +
 *     dispatcher; the returned app is served by the HTTP adapter
 *     (and every other surface via `hc<AppType>` /
 *     `createServerClient({ app })`). The triad `{ auth, loadRoles,
 *     dispatcher }` is all-or-nothing — partial shapes throw at
 *     composition time (see `app.ts` docblock).
 *   - `getApiApp(options?)` — the production composition root (ADR
 *     0027/0029 §8). Constructs the driver, auth (+ migrations),
 *     registry, sync, dispatcher, and role lookup from runtime config,
 *     then calls `createApiApp`. Returns a `BootedApp` (the trunk + a
 *     dependency-ordered `close()`). The `serve()` entrypoint and any
 *     in-process boot consume this; `createApiApp` is the lower layer
 *     that only assembles already-constructed singletons.
 *   - `app` — zero-arg default instance used by smoke tests and
 *     typed-RPC binding consumers that don't need the auth stack.
 *     `AppType` binds to this value.
 *   - `AppType` — the contract `packages/api-client` and every
 *     typed-client call site (frontend, tests, server-to-server route
 *     composition) binds against via `hc<AppType>`.
 *   - `openApiDocument(app)` — generate the trunk's OpenAPI 3.1 doc
 *     from the code-first route metadata. The public seam for the
 *     served spec + the CLI↔server parity check, so those consumers
 *     never import `hono-openapi` directly (ADR 0029 §7 fence).
 */

export { type AppType, app, type CreateApiAppOptions, createApiApp } from "./app";
export {
  type CreateApiDispatcherOptions,
  createApiDispatcher,
} from "./composition/createApiDispatcher";
// The trunk's Hono env — exported so the serve layer (apps/server) can
// instantiate generically-typed middleware (e.g. `serveStatic<ApiEnv>`)
// against `BootedApp["app"]` without re-deriving the type.
export type { ApiEnv } from "./env";
export { openApiDocument } from "./lib/openapi";
export {
  createDispatcherMiddleware,
  type DispatcherMiddlewareOptions,
} from "./middleware/dispatcher";
export {
  createPrincipalMiddleware,
  type PrincipalMiddlewareOptions,
  type PrincipalResolver,
} from "./middleware/principal";
export { type BootedApp, type GetApiAppOptions, getApiApp } from "./server";
