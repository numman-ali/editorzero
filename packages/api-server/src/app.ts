/**
 * Hono trunk — every editorzero surface (HTTP, CLI, MCP, Web UI in-
 * process callers) consumes this `app` via `hc<AppType>` (ADR 0021).
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
 * **Future state.** Domain tuples become codegen-emitted from the
 * capability registry; the trunk spread pattern is unchanged. This is
 * why the "Modular Organization" tuple-spread pattern was chosen over
 * `.route(prefix, subApp)` chaining or `createFactory()`-based sub-
 * apps. See ADR 0021 for the full rationale.
 */

import { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "./env";
import { infraRoutes } from "./routes/infra";

export const app = new OpenAPIHono<ApiEnv>().openapiRoutes([...infraRoutes] as const);

export type AppType = typeof app;
