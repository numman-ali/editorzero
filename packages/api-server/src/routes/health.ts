/**
 * `/health` — liveness probe.
 *
 * Not a capability; infrastructure. Exists so smoke deploys, container
 * health checks, and load-balancer probes have a stable endpoint that
 * does not require auth, does not touch the DB, and does not exercise
 * any capability handler. The `now` field is intentionally present so
 * operators can verify the probe is actually hitting the running
 * process (vs. a cached 200 from an intermediary).
 *
 * Canonical per-capability route-file shape — one `OpenAPIHono`
 * sub-app, one `.openapi(routeSpec, handler)` call, exported as the
 * default for the top-level `app.ts` to mount via `.route('/', sub)`.
 * Every capability route file under this directory follows the same
 * shape so the registry-driven generator that lands with the first
 * real capability slice has one consistent target.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

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
  path: "/health",
  tags: ["infra"],
  summary: "Liveness probe",
  responses: {
    200: {
      description: "Server is alive.",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

export const healthApp = new OpenAPIHono().openapi(healthRoute, (c) =>
  c.json({ status: "ok" as const, now: Date.now() }, 200),
);
