/**
 * Hono trunk — every editorzero surface (HTTP, CLI, MCP, Web UI in-
 * process callers) consumes this trunk via `hc<AppType>` (ADR 0021).
 *
 * **Two shapes.** `createApiApp({ auth?, dispatcher? })` is the
 * composition-root factory — the production trunk calls it once at
 * boot with a concrete Better Auth instance + dispatcher and caches
 * the returned app. `app` is a zero-arg default instance used by the
 * trunk-composition smoke, the api-client smoke, and any consumer
 * that needs an `AppType` binding without a running auth stack.
 * `AppType` (typed from the default `app`) is stable across both
 * shapes because the routes registered via `openapiRoutes([...] as
 * const)` are the same in both — only the middleware attached to
 * `/docs/*` differs. `hc<AppType>` bindings do not need to know
 * whether auth is wired.
 *
 * **Composition primitive.** Routes live one-per-folder under
 * `src/routes/<domain>/<capability>/index.ts` as `defineOpenAPIRoute(
 * { route, handler })` exports. Each domain aggregates its routes into
 * a readonly tuple in `src/routes/<domain>/index.ts`. The trunk
 * spreads every domain tuple into a single literal at the
 * `openapiRoutes(...)` call site. This is the
 * `@hono/zod-openapi@1.3.0` "Modular Organization" pattern.
 *
 * **Why the spread must be at the call site, not assigned to a
 * variable first.** `openapiRoutes` types the tuple via a `const
 * Inputs extends readonly {...}[]` generic; `SchemaFromRoutes` then
 * recurses `[infer Head, ...infer Tail]`. The `const` modifier
 * preserves literal tuple types on inference *from the argument
 * expression*. Assigning the spread to `const routes = [...a, ...b]`
 * without a trailing `as const` widens to `Array<...>`, and the
 * subsequent `openapiRoutes(routes)` loses the per-element Schema
 * merge — which means `hc<AppType>` RPC typing silently collapses to
 * `unknown`. Keep the spread inline.
 *
 * **Path == folder path.** `routes/infra/health/` exposes
 * `/infra/health`. Every route's path mirrors its folder path so the
 * filesystem is self-documenting: finding the handler for a URL is a
 * matter of reading the path off the URL and navigating the tree.
 * Non-capability endpoints (health, readiness, version) live under
 * `infra/` precisely so they're visibly not capability endpoints.
 *
 * **Env discipline.** One `ApiEnv` lives on the trunk; route modules
 * type against it (or a subset assignable to it). `OpenAPIHono.route(
 * )` does not merge sub-app `Env` into the parent return type, so
 * per-module envs fragment the `c.var` surface at composition time.
 * `hc<AppType>` extracts Schema, not `Env` — so the `Env` contract is
 * purely server-internal.
 *
 * **Better Auth mount.** `app.on(["POST","GET"], "/auth/*", c =>
 * auth.handler(c.req.raw))` is the Better Auth 1.6.5 Hono-integration
 * shape. `basePath: "/auth"` on `createAuth(...)` keeps the paths in
 * lockstep — Better Auth's client-side routes (`/sign-in/email`,
 * `/sign-up/email`, `/get-session`, ...) compose under `/auth/*`. The
 * mount is on the non-typed `.on()` method rather than `openapiRoutes
 * ([...] as const)` because Better Auth owns its own request/response
 * contract (not our zod-validated capability shape); exposing it
 * through OpenAPI would conflate the two contract systems. Auth
 * endpoints are documented separately via `auth.api.getOpenAPISchema(
 * )` if needed.
 *
 * **Capability-route middleware.** `/docs/*` (and every future
 * capability-domain prefix) is mounted behind `createPrincipalMiddleware`
 * + `createDispatcherMiddleware`. Principal runs first, short-circuits
 * 401 on missing/invalid session; dispatcher runs second, attaches the
 * process-scoped `Dispatcher` to `c.var` for capability handlers to
 * invoke. Public routes (`/infra/*`, `/auth/*`) do not mount this
 * chain — those paths live outside the capability domain.
 *
 * **Middleware order is load-bearing.** Principal must run before
 * dispatcher (dispatcher's work is capability-invocation, which needs
 * a principal) and both must run before the route handler reads
 * `c.var.principal` / `c.var.dispatcher`. Hono preserves `app.use(...)`
 * registration order within a path prefix.
 *
 * **Future state.** Domain tuples become codegen-emitted from the
 * capability registry; the trunk spread pattern is unchanged. This is
 * why the "Modular Organization" tuple-spread pattern was chosen over
 * `.route(prefix, subApp)` chaining or `createFactory()`-based sub-
 * apps. See ADR 0021 for the full rationale.
 */

import type { Auth } from "@editorzero/auth";
import { createBetterAuthResolver } from "@editorzero/auth";
import type { Dispatcher } from "@editorzero/dispatcher";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "./env";
import { createDispatcherMiddleware } from "./middleware/dispatcher";
import { createPrincipalMiddleware } from "./middleware/principal";
import { docsRoutes } from "./routes/docs";
import { infraRoutes } from "./routes/infra";

export interface CreateApiAppOptions {
  /**
   * Better Auth instance. When provided, `auth.handler` is mounted
   * on `/auth/*` (POST + GET) so Better Auth's sign-up / sign-in /
   * session endpoints compose under the trunk, and
   * `createBetterAuthResolver(auth)` powers the `/docs/*` principal
   * middleware. Omit for tests or smoke-level composition checks
   * that don't need the auth stack — capability routes still mount
   * but `/docs/*` 401s on every request (no resolver → no principal).
   */
  readonly auth?: Auth;
  /**
   * Dispatcher composition-root instance. Required in production for
   * `/docs/*` routes to actually execute capabilities; without it,
   * the dispatcher middleware is omitted and a capability route that
   * reached its handler would crash reading `c.var.dispatcher`. In
   * practice the principal middleware 401s first when auth is also
   * absent, so the default zero-arg `app` stays safe for the health-
   * probe tests it's used in.
   */
  readonly dispatcher?: Dispatcher;
}

export function createApiApp(options: CreateApiAppOptions = {}) {
  const { auth, dispatcher } = options;
  const trunk = new OpenAPIHono<ApiEnv>();

  if (auth !== undefined) {
    trunk.on(["POST", "GET"], "/auth/*", (c) => auth.handler(c.req.raw));
    // Principal middleware for every capability-domain prefix. Today
    // just `/docs/*`; future prefixes (`/blocks/*`, `/workspaces/*`)
    // repeat this line.
    trunk.use(
      "/docs/*",
      createPrincipalMiddleware({
        resolve: (c) => createBetterAuthResolver(auth)(c.req.raw.headers),
      }),
    );
  }
  if (dispatcher !== undefined) {
    trunk.use("/docs/*", createDispatcherMiddleware({ dispatcher }));
  }

  return trunk.openapiRoutes([...infraRoutes, ...docsRoutes] as const);
}

/**
 * Default trunk instance — zero-arg composition. Exists so
 * `packages/api-client` smoke tests and the trunk-composition smoke
 * can bind `hc<AppType>` without spinning up a full auth stack.
 * Production composition roots construct their own via
 * `createApiApp({ auth, dispatcher })`.
 *
 * **Capability routes mounted on this default app will 401** because
 * the principal middleware isn't wired (no `auth` passed). The RPC
 * surface is still typed (`hc<AppType>.docs.list.$get`); tests that
 * need to exercise the handler use `createApiApp({ auth, dispatcher })`
 * directly.
 */
export const app = createApiApp();

export type AppType = typeof app;
