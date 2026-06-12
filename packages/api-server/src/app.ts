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
 * `app`) is stable across both shapes because the routes mounted via
 * the `.route(prefix, subApp)` chain are the same in both — only the
 * middleware attached to `/docs/*` differs. `hc<AppType>` bindings do
 * not need to know whether auth is wired.
 *
 * **Composition primitive (ADR 0029, code-first).** Routes live one-
 * per-file under `src/routes/<domain>/<capability>.ts` (co-located
 * unit test at `<capability>.unit.test.ts`), each exporting a self-
 * contained `Hono<ApiEnv>` sub-app built from
 * `factory.createHandlers(describeRoute, validator, handler)`. Each
 * domain composes its routes into one sub-app in
 * `src/routes/<domain>/index.ts` (the only `index.ts` per domain) via a
 * chained `.route("/", subApp)` chain; the trunk then mounts each
 * domain sub-app at its prefix with `.route("/<domain>", <domain>)`.
 * OpenAPI metadata rides on each route's `describeRoute` middleware and
 * is read statically by `generateSpecs(app)` (no central route
 * registry).
 *
 * **Why the `.route()` chain must stay contiguous.** Base Hono's
 * `.route(path, subApp)` merges the sub-app's RPC `Schema` into the
 * parent app's return type, and a fluent chain accumulates the union
 * across every mount. `hc<AppType>` reads that accumulated `Schema` to
 * reconstruct `client.docs.create.$post` etc. Breaking the chain —
 * assigning an intermediate to a `const` and re-mounting it, or looping
 * `for (const r of routes) trunk.route(...)` — drops the per-mount
 * `Schema` accumulation and collapses `hc<AppType>` RPC typing to
 * `unknown`. Keep the mounts a single contiguous `.route(...).route(
 * ...)` expression at both levels (domain index and trunk). (The prior
 * `@hono/zod-openapi` design used an `openapiRoutes([...] as const)`
 * tuple specifically *because* `OpenAPIHono.route()` did not merge the
 * OpenAPI registry across sub-apps; the code-first `hono-openapi`
 * substrate has no such limitation, so ADR 0029 reverses that choice
 * back to idiomatic `.route()` composition.)
 *
 * **Path == folder path.** `routes/infra/health.ts` exposes
 * `/infra/health` (the route mounts the relative `/health`; the trunk
 * adds the `/infra` prefix). Every route's path mirrors its folder path
 * so the filesystem is self-documenting: finding the handler for a URL
 * is a matter of reading the path off the URL and navigating the tree.
 * Non-capability endpoints (health, readiness, version) live under
 * `infra/` precisely so they're visibly not capability endpoints.
 *
 * **Env discipline.** One `ApiEnv` lives on the trunk; route modules
 * type against it (or a subset assignable to it). `Hono.route()` merges
 * sub-app `Schema` into the parent return type but *not* `Env`, so
 * per-module envs would fragment the `c.var` surface — every sub-app
 * here is `new Hono<ApiEnv>()`, so there is one env and no
 * fragmentation. `hc<AppType>` extracts Schema, not `Env` — so the
 * `Env` contract is purely server-internal.
 *
 * **Better Auth mount.** `app.on(["POST","GET"], "/auth/*", c =>
 * auth.handler(c.req.raw))` is the Better Auth 1.6.5 Hono-integration
 * shape. `basePath: "/auth"` on `createAuth(...)` keeps the paths in
 * lockstep — Better Auth's client-side routes (`/sign-in/email`,
 * `/sign-up/email`, `/get-session`, ...) compose under `/auth/*`. The
 * mount is on the non-typed `.on()` method rather than a typed
 * `.route()` mount because Better Auth owns its own request/response
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
 * **Future state.** The per-capability route modules + domain sub-apps
 * become codegen-emitted from the capability registry (one `Hono` sub-
 * app per capability, one chained domain index per domain); the trunk's
 * `.route()` mount chain is unchanged. The `createFactory<ApiEnv>()` +
 * `.route()` composition (ADR 0029) is what makes each route module a
 * standalone, individually-testable, codegen-friendly unit. See ADR
 * 0021 (transport topology) and ADR 0029 (code-first package shape).
 */

import type { Auth } from "@editorzero/auth";
import { createBetterAuthResolver } from "@editorzero/auth";
import type { Registry } from "@editorzero/capabilities";
import type { LoadRoles } from "@editorzero/db";
import type { Dispatcher } from "@editorzero/dispatcher";
import { EditorZeroError } from "@editorzero/errors";
import type { SessionId, UserId } from "@editorzero/ids";
import { createMcpHandler } from "@editorzero/mcp-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { ApiEnv } from "./env";
import { createDispatcherMiddleware } from "./middleware/dispatcher";
import { createPrincipalMiddleware } from "./middleware/principal";
import { audit } from "./routes/audit";
import { collections } from "./routes/collections";
import { docs } from "./routes/docs";
import { infra } from "./routes/infra";
import { permissions } from "./routes/permissions";
import { spaces } from "./routes/spaces";
import { workspaces } from "./routes/workspaces";

/**
 * What a successful auth-revocation endpoint revoked (ADR 0043
 * Decision 5, sign-out arm). `session` — the caller's current session
 * (`POST /auth/sign-out`); `user` — every session the caller holds
 * (`POST /auth/revoke-sessions` / `revoke-other-sessions`; deliberately
 * blunt — re-attach re-runs collab authorization, which is the
 * authority).
 */
export type AuthRevocation =
  | { readonly kind: "session"; readonly session_id: SessionId }
  | { readonly kind: "user"; readonly user_id: UserId };

/**
 * Better Auth endpoints whose success revokes session standing, mapped
 * to the close scope they imply. `POST /auth/revoke-session` (single
 * foreign session, token in body) is the named residual: mapping its
 * body token to a `session_id` needs a session-table read, and no
 * surface exposes per-device revocation yet — it joins this map when
 * one does.
 */
const AUTH_REVOCATION_PATHS: ReadonlyMap<string, "session" | "user"> = new Map([
  ["/auth/sign-out", "session"],
  ["/auth/revoke-sessions", "user"],
  ["/auth/revoke-other-sessions", "user"],
]);

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
  /**
   * Sign-out arm of the collab revocation tap (ADR 0043 Decision 5).
   * Fired after a revocation-class `/auth/*` endpoint succeeds —
   * Better Auth owns session destruction, so the trunk is the only
   * place that sees it happen. The composition root closes the
   * matching collab sockets (`closeBySession` / `closeByUser`); a
   * surviving client that reconnects re-runs `collabAuthorize`, which
   * refuses. Per-frame principal re-resolution already protects
   * writes — this closes the passive read feed. Requires `auth` (the
   * tap rides the `/auth/*` mount); the factory throws otherwise.
   */
  readonly onAuthRevoked?: (revocation: AuthRevocation) => void;
}

/**
 * Detect Postgres retryable-serialization failures (`40001`
 * serialization_failure, `40P01` deadlock_detected). `pg` exposes the
 * SQLSTATE on the thrown error's `.code` property as a 5-char string.
 * Used by the global error mapper to project the "loser of a
 * SERIALIZABLE race" as a typed 409 conflict rather than a 500. See
 * ADR 0023 §3 + `drivers/postgres.ts` header; bounded retry inside the
 * driver is deferred.
 */
function isPgRetryableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code: unknown }).code;
  return code === "40001" || code === "40P01";
}

export function createApiApp(options: CreateApiAppOptions = {}) {
  const { auth, loadRoles, dispatcher, registry, mcpServerInfo, onAuthRevoked } = options;

  // ADR 0043 Decision 5 — the sign-out tap rides the `/auth/*` mount.
  if (onAuthRevoked !== undefined && auth === undefined) {
    throw new Error(
      "createApiApp: `onAuthRevoked` was provided without `auth`. The revocation " +
        "tap wraps the `/auth/*` mount; without `auth` it would never fire.",
    );
  }

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

  // No DOM shim here since ADR 0038: content mutations flow through the
  // owned DOM-free write path (`@editorzero/sync` readBlocks/writeBlocks)
  // — the trunk never registers happy-dom.

  const trunk = new Hono<ApiEnv>();

  // **Error mapper** — every `EditorZeroError` subclass carries its
  // HTTP status + code literal (`packages/errors/src/index.ts`);
  // dispatch-path throws surface here when a capability handler (or
  // the dispatcher itself) raises. Narrow projection: status from
  // `err.httpStatus`, body `{ error: err.code }` — same shape every
  // route's zod error response already documents for 400/401/403.
  // Principal-middleware 401s are returned via `c.json(...)` directly
  // (not thrown), so this mapper doesn't touch them.
  //
  // **PG retryable-serialization failures → 409 conflict.** Under
  // Postgres SERIALIZABLE (ADR 0023 §3), `withSystemTx` can abort with
  // `40001` (serialization_failure) or `40P01` (deadlock_detected) —
  // the loser of a concurrent-mutation race. These bubble out of the
  // write-path tx as raw `pg` errors (not `EditorZeroError` subclasses;
  // bounded retry inside the driver is deferred per `drivers/postgres.ts`
  // header). The mapper projects them to a typed 409 `conflict` so the
  // surface contract holds — the invariant being protected has held,
  // the loser just needs to retry. SQLite (BEGIN IMMEDIATE single-writer)
  // never produces these codes so this branch is PG-only in practice.
  //
  // Plain non-typed errors fall through to Hono's default 500.
  trunk.onError((err, c) => {
    if (err instanceof EditorZeroError) {
      return c.json({ error: err.code }, err.httpStatus as ContentfulStatusCode);
    }
    if (isPgRetryableError(err)) {
      return c.json({ error: "conflict" }, 409);
    }
    throw err;
  });

  if (auth !== undefined && loadRoles !== undefined) {
    const resolve = createBetterAuthResolver({ auth, loadRoles });
    // The `/auth/*` mount carries the sign-out arm of the revocation
    // tap (ADR 0043 Decision 5): capture the caller's identity BEFORE
    // Better Auth destroys the session, fire `onAuthRevoked` only
    // after the handler confirms (`response.ok`). Containment on both
    // edges — resolution failure falls back to the bare handler (the
    // close is a liveness improvement, not a gate: an unclosed socket
    // lingers only until its next refused write), and a throwing
    // callback never turns a committed revocation into a 5xx.
    trunk.on(["POST", "GET"], "/auth/*", async (c) => {
      const closeKind = c.req.method === "POST" ? AUTH_REVOCATION_PATHS.get(c.req.path) : undefined;
      if (onAuthRevoked === undefined || closeKind === undefined) {
        return auth.handler(c.req.raw);
      }
      const principal = await resolve(c.req.raw.headers).catch(() => null);
      const response = await auth.handler(c.req.raw);
      if (response.ok && principal !== null) {
        try {
          if (closeKind === "session") {
            if (principal.session_id !== null) {
              onAuthRevoked({ kind: "session", session_id: principal.session_id });
            }
          } else {
            onAuthRevoked({ kind: "user", user_id: principal.id });
          }
        } catch {
          // The revocation already committed inside Better Auth; a tap
          // failure is a socket-liveness gap, never an auth failure.
        }
      }
      return response;
    });
    // Principal middleware for every capability-domain prefix. Today
    // just `/docs/*`; future prefixes (`/blocks/*`, `/workspaces/*`)
    // repeat this line. Also attached to `/infra/whoami` (ADR 0025)
    // — the CLI's canonical principal-orientation route, auth-gated
    // even though it shares the `/infra/` prefix with the public
    // `/infra/health` liveness probe. Exact-path attachment keeps
    // `/infra/health` public.
    const principalMw = createPrincipalMiddleware({
      resolve: (c) => resolve(c.req.raw.headers),
    });
    // Every capability-domain prefix mounted in the trunk chain below
    // MUST appear here AND in the dispatcher block — a mounted domain
    // without these 500s on its first live request (undefined
    // `c.var.principal`). The auth-chain integration test walks the
    // mounted prefixes and asserts 401-not-500 to keep this list
    // honest (the `/permissions` slice shipped without it — caught
    // only when the next domain landed).
    trunk.use("/docs/*", principalMw);
    trunk.use("/collections/*", principalMw);
    trunk.use("/workspaces/*", principalMw);
    trunk.use("/permissions/*", principalMw);
    trunk.use("/spaces/*", principalMw);
    trunk.use("/audits/*", principalMw);
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
    trunk.use("/workspaces/*", dispatcherMw);
    trunk.use("/permissions/*", dispatcherMw);
    trunk.use("/spaces/*", dispatcherMw);
    trunk.use("/audits/*", dispatcherMw);
  }

  // Mount each domain sub-app at its prefix. The fluent `.route()`
  // chain is load-bearing for `hc<AppType>`: base Hono's `.route()`
  // merges each sub-app's RPC `Schema` into the return type, and the
  // chain accumulates the union across all seven domains. Keep it a
  // single contiguous expression — an intermediate `const` re-mount is
  // the shape most prone to widening the inferred schema to `unknown`.
  // `audit` mounts at the plural `/audits` prefix (dir is singular).
  return trunk
    .route("/infra", infra)
    .route("/docs", docs)
    .route("/collections", collections)
    .route("/workspaces", workspaces)
    .route("/permissions", permissions)
    .route("/spaces", spaces)
    .route("/audits", audit);
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
