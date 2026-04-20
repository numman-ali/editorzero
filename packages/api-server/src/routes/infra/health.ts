/**
 * `GET /infra/health` — liveness probe.
 *
 * Not a capability; infrastructure. Exists so smoke deploys, container
 * health checks, and load-balancer probes have a stable endpoint that
 * does not require auth, does not touch the DB, and does not exercise
 * any capability handler. The `now` field is intentionally present so
 * operators can verify the probe is actually hitting the running
 * process (vs. a cached 200 from an intermediary).
 *
 * **Path mirrors folder path.** `src/routes/infra/health/` → `/infra/
 * health`. That invariant is the whole filesystem-as-routing-table
 * posture: a human or agent wanting the handler for `GET /infra/health`
 * reads the path off the URL and navigates the folder tree — no
 * registry lookup needed. Non-capability paths live under `infra/`
 * precisely so they're visibly *not* capability endpoints.
 *
 * **Route-file shape.** One `defineOpenAPIRoute({ route, handler })`
 * export per folder. The domain aggregator (`routes/infra/index.ts`)
 * collects these into a `readonly [...]` tuple; the trunk
 * (`src/app.ts`) spreads all domain tuples into a single
 * `openapiRoutes([...] as const)` call. That composition primitive is
 * purpose-built for registry-driven generation: a future commit
 * replaces the hand-written tuples with ones emitted from the
 * capability registry. Crucially, `openapiRoutes` only preserves
 * `hc<AppType>` RPC typing if the tuple is literal at the call site —
 * which is why every aggregation step uses `as const`.
 *
 * **Middleware.** Route-level middleware (auth, tenant scope, rate
 * limit) lives on `route.middleware` and runs before the zod
 * validators — that ordering is what lets middleware resolve
 * `c.var.principal` etc. before the input schema validates against
 * the resolved tenant. `/infra/health` is public so the middleware
 * array is omitted.
 */

import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

const HealthResponse = z
  .object({
    status: z.literal("ok"),
    now: z.number().int().openapi({
      description: "Server epoch milliseconds at response time.",
      example: 1_700_000_000_000,
    }),
  })
  .openapi("HealthResponse");

const healthRoute = createRoute({
  method: "get",
  path: "/infra/health",
  tags: ["infra"],
  summary: "Liveness probe",
  responses: {
    200: {
      description: "Server is alive.",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

// `addRoute: true` is semantically redundant (the default is "register")
// but required under `exactOptionalPropertyTypes: true` — without it,
// `defineOpenAPIRoute`'s inferred `addRoute?: undefined` is not
// assignable to `openapiRoutes`'s expected `addRoute?: boolean`. Every
// entry in the registry-emitted tuple carries this field.
export const health = defineOpenAPIRoute({
  route: healthRoute,
  handler: (c) => c.json({ status: "ok" as const, now: Date.now() }, 200),
  addRoute: true,
});
