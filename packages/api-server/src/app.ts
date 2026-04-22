/**
 * Hono trunk — every editorzero surface (HTTP, CLI, MCP, Web UI in-
 * process callers) consumes this trunk via `hc<AppType>` (ADR 0021).
 *
 * **Two shapes.** `createApiApp({ auth, loadRoles, dispatcher,
 * registry? })` is the composition-root factory — the production
 * trunk calls it once at boot with a concrete Better Auth instance,
 * `loadRoles` callable, and dispatcher, and caches the returned app.
 * `app` is a zero-arg default instance used by the trunk-composition
 * smoke, the api-client smoke, and any consumer that needs an
 * `AppType` binding without a running auth stack. Partial shapes
 * (e.g., `{ auth, loadRoles }` without `dispatcher`, or `{ dispatcher }`
 * without `auth`) are rejected at composition time — see the guards
 * on `CreateApiAppOptions` below. `AppType` (typed from the default
 * `app`) is stable across both shapes because the routes registered
 * via `openapiRoutes([...] as const)` are the same in both — only the
 * middleware attached to `/docs/*` differs. `hc<AppType>` bindings do
 * not need to know whether auth is wired.
 *
 * **Composition primitive.** Routes live one-per-file under
 * `src/routes/<domain>/<capability>.ts` (co-located unit test at
 * `<capability>.unit.test.ts`) as `defineOpenAPIRoute({ route, handler })`
 * exports. Each domain aggregates its routes into a readonly tuple in
 * `src/routes/<domain>/index.ts` (the only `index.ts` per domain). The
 * trunk spreads every domain tuple into a single literal at the
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
 * **Capability-route middleware.** `/docs/*` and `/collections/*`
 * (and every future capability-domain prefix) are mounted behind
 * `createPrincipalMiddleware` + `createDispatcherMiddleware`. Principal
 * runs first, short-circuits 401 on missing/invalid session; dispatcher
 * runs second, attaches the process-scoped `Dispatcher` to `c.var` for
 * capability handlers to invoke. Public routes (`/infra/*`, `/auth/*`)
 * do not mount this chain — those paths live outside the capability
 * domain.
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
import type { Registry } from "@editorzero/capabilities";
import type { LoadRoles } from "@editorzero/db";
import type { Dispatcher } from "@editorzero/dispatcher";
import { EditorZeroError } from "@editorzero/errors";
import { createMcpHandler } from "@editorzero/mcp-server";
import { ensureDomGlobals } from "@editorzero/sync";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { ApiEnv } from "./env";
import { createDispatcherMiddleware } from "./middleware/dispatcher";
import { createPrincipalMiddleware } from "./middleware/principal";
import { collectionsRoutes } from "./routes/collections";
import { docsRoutes } from "./routes/docs";
import { infraRoutes } from "./routes/infra";

export interface CreateApiAppOptions {
  /**
   * Better Auth instance. When provided, `auth.handler` is mounted
   * on `/auth/*` (POST + GET) so Better Auth's sign-up / sign-in /
   * session endpoints compose under the trunk, and
   * `createBetterAuthResolver({ auth, loadRoles })` powers the
   * `/docs/*` + `/infra/whoami` principal middleware. Omit only for
   * the zero-arg smoke-composition shape — see the triad guard
   * below.
   *
   * **Triad constraint.** `{ auth, loadRoles, dispatcher }` is
   * all-or-nothing. Partial shapes mount `/docs/*` routes with
   * missing middleware — the handler then throws a TypeError on the
   * first matching request (reads `c.var.principal` or
   * `c.var.dispatcher`). The factory throws at composition time
   * whenever the triad is partially provided; this keeps the
   * failure loud at boot rather than a silent footgun at first
   * request. ADR 0024 separately requires `auth` ↔ `loadRoles`
   * pairing (the resolver reads `workspace_members` via the
   * callable).
   */
  readonly auth?: Auth;
  /**
   * Layer-1 role lookup (ADR 0024). Produced via
   * `createLoadRoles(driver)` in `@editorzero/db`. Injected rather
   * than constructed here because the composition root owns the
   * driver; the api-server factory stays ignorant of Kysely +
   * `SystemDatabase` (pinned to `packages/db/**` by the
   * `no-raw-kysely-outside-db` coherence rule). Paired with `auth`;
   * see the doc-block on `auth` above for the runtime guard.
   */
  readonly loadRoles?: LoadRoles;
  /**
   * Dispatcher composition-root instance. Required alongside `auth`
   * + `loadRoles` for `/docs/*` routes to mount a complete
   * middleware chain. Part of the triad guard on `auth` above — the
   * factory throws if `dispatcher` is provided without `auth`, or
   * `auth` without `dispatcher`, since the partial shape would
   * attach one middleware but not the other and the first
   * capability request would crash reading `c.var.principal` /
   * `c.var.dispatcher`. The zero-arg `app` default (no triad
   * members) stays safe only for the typed-RPC binding + public
   * `/infra/health` + `/infra/version` probes; a request to
   * `/docs/*` on the zero-arg app still reaches an unguarded
   * handler and crashes. That surface is intentional — typed-RPC
   * callers never issue those requests, and the smoke tests cover
   * only public paths.
   */
  readonly dispatcher?: Dispatcher;
  /**
   * Capability registry. When provided alongside `dispatcher`, the
   * MCP adapter mounts at `/mcp` behind the same principal chain
   * that `/docs/*` uses (ADR 0026). The adapter reads the registry
   * once at mount time to build the tool list; capabilities are
   * filtered via `isMcpTool` (`surfaces.includes("mcp") &&
   * !humanOnly`). Omit when building a trunk that does not expose
   * MCP — e.g., the zero-arg `app` default used by api-client smoke
   * bindings.
   *
   * **Pairing constraint.** `registry` requires `dispatcher`: the
   * MCP handler closes over the dispatcher to execute tool calls.
   * The factory throws at composition time if `registry` arrives
   * without `dispatcher`; providing `dispatcher` without `registry`
   * is fine (MCP simply does not mount).
   */
  readonly registry?: Registry;
  /**
   * Server identity advertised in the MCP `initialize` handshake.
   * Optional: defaults to `{ name: "editorzero", version: "0.0.0" }`.
   * Production should pass the real package version — the MCP client
   * surfaces this to end-users as `serverInfo`.
   */
  readonly mcpServerInfo?: { readonly name: string; readonly version: string };
}

export function createApiApp(options: CreateApiAppOptions = {}) {
  const { auth, loadRoles, dispatcher, registry, mcpServerInfo } = options;

  // ADR 0024 — `auth` and `loadRoles` are the auth-resolver pair.
  if (auth !== undefined && loadRoles === undefined) {
    throw new Error(
      "createApiApp: `auth` was provided without `loadRoles`. ADR 0024 requires " +
        "the role-lookup callable at composition time. Pass " +
        "`loadRoles: createLoadRoles(driver)` from `@editorzero/db`.",
    );
  }
  if (auth === undefined && loadRoles !== undefined) {
    throw new Error(
      "createApiApp: `loadRoles` was provided without `auth`. The two must be " +
        "provided together — `loadRoles` is only consumed by the auth resolver.",
    );
  }
  // ADR 0026 slice-1 — `registry` requires the full triad. Checked
  // before the generic triad guards below so the diagnostic points
  // at the MCP mount intent rather than an arbitrary pair-wise
  // failure.
  if (registry !== undefined && dispatcher === undefined) {
    throw new Error(
      "createApiApp: `registry` was provided without `dispatcher`. The MCP " +
        "adapter closes over the dispatcher to execute tool calls; passing a " +
        "registry without a dispatcher would mount `/mcp` with no way to run " +
        "capabilities.",
    );
  }
  if (registry !== undefined && auth === undefined) {
    throw new Error(
      "createApiApp: `registry` was provided without `auth`. ADR 0026 slice 1 " +
        "mounts `/mcp` behind the session-cookie principal chain; without auth + " +
        "loadRoles the route would have no principal middleware and every tool " +
        "call would crash reading `c.var.principal`. Provide `auth` + `loadRoles` " +
        "alongside `registry`, or omit `registry` to not expose MCP.",
    );
  }
  // Triad invariant — `/docs/*` handlers read both `c.var.principal`
  // (set by the principal middleware, which only attaches when
  // `auth` + `loadRoles` are present) and `c.var.dispatcher` (set
  // by the dispatcher middleware, which only attaches when
  // `dispatcher` is present). A partial shape mounts the routes but
  // leaves one middleware unattached — the first `/docs/*` request
  // crashes with TypeError. Fail loud at composition time.
  if (auth !== undefined && dispatcher === undefined) {
    throw new Error(
      "createApiApp: `auth` was provided without `dispatcher`. The `/docs/*` " +
        "routes need both the principal middleware (from `auth` + `loadRoles`) " +
        "and the dispatcher middleware; a partial shape would crash on first " +
        "request reading `c.var.dispatcher`. Provide all three together or none.",
    );
  }
  if (auth === undefined && dispatcher !== undefined) {
    throw new Error(
      "createApiApp: `dispatcher` was provided without `auth`. The `/docs/*` " +
        "routes need the principal middleware alongside the dispatcher " +
        "middleware; a partial shape would crash on first request reading " +
        "`c.var.principal`. Provide all three together or none.",
    );
  }

  // **DOM shim for content-mutation capabilities.** `doc.rename` (and
  // future `doc.update`) open a live `BlockNoteEditor` inside
  // `ctx.transact`; ProseMirror's `view.dispatch` path requires
  // `document` / `window` on `globalThis`. `ensureDomGlobals` is
  // idempotent (typeof-guarded), so this coexists with tests that
  // pre-install a DOM via `@vitest-environment happy-dom`.
  //
  // Conditional on `dispatcher !== undefined`: the zero-arg
  // `createApiApp()` is a typed-RPC binding shape used by
  // `@editorzero/api-client` + trunk-composition smokes that never
  // invoke a handler — keeping the shim out of that path avoids a
  // surprise module-load side effect for consumers that just bind
  // `hc<AppType>` over the types.
  if (dispatcher !== undefined) {
    ensureDomGlobals();
  }

  const trunk = new OpenAPIHono<ApiEnv>();

  // **Error mapper** — every `EditorZeroError` subclass carries its
  // HTTP status + code literal (`packages/errors/src/index.ts`);
  // dispatch-path throws surface here when a capability handler (or
  // the dispatcher itself) raises. Plain non-typed errors fall through
  // to Hono's default 500. Narrow projection: status from
  // `err.httpStatus`, body `{ error: err.code }` — same shape every
  // route's zod error response already documents for 400/401/403.
  // Principal-middleware 401s are returned via `c.json(...)` directly
  // (not thrown), so this mapper doesn't touch them.
  trunk.onError((err, c) => {
    if (err instanceof EditorZeroError) {
      return c.json({ error: err.code }, err.httpStatus as ContentfulStatusCode);
    }
    throw err;
  });

  if (auth !== undefined && loadRoles !== undefined) {
    trunk.on(["POST", "GET"], "/auth/*", (c) => auth.handler(c.req.raw));
    // Principal middleware for every capability-domain prefix. Today
    // just `/docs/*`; future prefixes (`/blocks/*`, `/workspaces/*`)
    // repeat this line. Also attached to `/infra/whoami` (ADR 0025)
    // — the CLI's canonical principal-orientation route, auth-gated
    // even though it shares the `/infra/` prefix with the public
    // `/infra/health` liveness probe. Exact-path attachment keeps
    // `/infra/health` public.
    const resolve = createBetterAuthResolver({ auth, loadRoles });
    const principalMw = createPrincipalMiddleware({
      resolve: (c) => resolve(c.req.raw.headers),
    });
    trunk.use("/docs/*", principalMw);
    trunk.use("/collections/*", principalMw);
    trunk.use("/infra/whoami", principalMw);
    // `/mcp` is authenticated via the same principal chain (ADR 0026
    // commitment 1: session cookie resolves to `c.var.principal`; no
    // `authInfo.extra.principal` smuggling). The composition guards
    // above ensure `registry` only arrives when `auth`/`loadRoles` do.
    if (registry !== undefined && dispatcher !== undefined) {
      trunk.use("/mcp", principalMw);
      // MCP adapter mount (ADR 0026). Outside the OpenAPI route system:
      // MCP uses JSON-RPC over Streamable HTTP, not the zod-validated
      // capability shape. Same shape as `/auth/*` — registered on the
      // non-typed `.all()` method so `hc<AppType>` RPC typing is not
      // contaminated by a non-REST contract. No OAuth discovery metadata
      // mounts here (ADR 0026 commitment 6 — slice 1 only).
      trunk.all(
        "/mcp",
        createMcpHandler({
          registry,
          dispatcher,
          serverInfo: mcpServerInfo ?? { name: "editorzero", version: "0.0.0" },
        }),
      );
    }
  }
  if (dispatcher !== undefined) {
    const dispatcherMw = createDispatcherMiddleware({ dispatcher });
    trunk.use("/docs/*", dispatcherMw);
    trunk.use("/collections/*", dispatcherMw);
  }

  return trunk.openapiRoutes([...infraRoutes, ...docsRoutes, ...collectionsRoutes] as const);
}

/**
 * Default trunk instance — zero-arg composition. Exists so
 * `packages/api-client` smoke tests and the trunk-composition smoke
 * can bind `hc<AppType>` without spinning up a full auth stack.
 * Production composition roots construct their own via
 * `createApiApp({ auth, loadRoles, dispatcher })`.
 *
 * **Capability routes mounted on this default app will crash on
 * request** — no principal middleware (no `auth`) means no
 * `c.var.principal`; no dispatcher middleware (no `dispatcher`)
 * means no `c.var.dispatcher`; the handlers read both unguarded.
 * The RPC surface is still typed (`hc<AppType>.docs.list.$get`);
 * tests that need to exercise the handler use `createApiApp({ auth,
 * loadRoles, dispatcher })` directly. Public `/infra/*` paths
 * (health, version) stay safe because they don't read auth/dispatch
 * context; `/infra/whoami` is gated by the principal chain and
 * therefore also only functional on the full-triad shape.
 */
export const app = createApiApp();

export type AppType = typeof app;
