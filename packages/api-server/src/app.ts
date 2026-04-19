/**
 * Hono trunk — every editorzero surface (HTTP, CLI, MCP, Web UI in-
 * process callers) consumes this `app` via `hc<AppType>` (ADR 0021).
 *
 * **Load-bearing composition rule.** Routes are defined per-file in
 * `./routes/*.ts` as standalone `OpenAPIHono` sub-apps, then mounted
 * here via a *single chained expression* — `new OpenAPIHono().route(...)
 * .route(...)`. TypeScript's RPC type inference only flows when the
 * chain is captured in one `const` (see `hc` / `testClient` docs).
 * Rebinding `app = app.route(...)` across statements collapses the
 * types to the base `OpenAPIHono`, breaking `hc<AppType>` consumers.
 * The test in `app.unit.test.ts` guards this empirically — if the
 * chain pattern regresses, the typed client call fails to compile.
 *
 * **Why `OpenAPIHono` instead of `createFactory<Env>().createApp()`.**
 * `@hono/zod-openapi` preserves OpenAPI route metadata only when
 * mounted onto an `OpenAPIHono` instance; plain Hono sub-apps are
 * OpenAPI-invisible. The factory helper from `hono/factory` is useful
 * for middleware/dependency bundles, but the trunk itself must be
 * `OpenAPIHono` so registry-generated routes carry their schemas
 * through to the OpenAPI spec + the typed-RPC shape.
 *
 * **Future slices.** Middleware (Better Auth → `Principal`, tenant
 * scope into `AsyncLocalStorage`, rate limit, OTel span, capability
 * dispatcher) mounts on *this* app before the route composition. The
 * first real capability (`doc.create`) lands in a subsequent commit
 * once the dispatcher composition root wires a non-test runtime.
 */

import { OpenAPIHono } from "@hono/zod-openapi";

import { healthApp } from "./routes/health";

export const app = new OpenAPIHono().route("/", healthApp);

export type AppType = typeof app;
