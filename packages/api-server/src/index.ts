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
