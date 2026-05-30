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
 * **Pattern INFRA_HEALTH (code-first, ADR 0029/0034).** Unlike a
 * capability route, there is no capability id, no dispatcher, and no
 * principal — so the handler is plain and *synchronous*: no `validator`
 * (nothing to parse off the request), no `try`/`catch`, no
 * `errorResponse`. The route is still a self-contained `Hono<ApiEnv>`
 * sub-app built from `factory.createHandlers(describeRoute({ ... }),
 * handler)`, mirroring the capability-route shape so the trunk composes
 * every route uniformly and `hc<AppType>` keeps RPC typing.
 *
 *   - `describeRoute({ ... })` — OpenAPI metadata only (summary, tags,
 *     the 200 response schema). Documents the contract; does not feed
 *     `hc`.
 *   - The handler — returns `{ status: "ok", now: Date.now() }` through
 *     `c.json(..., 200)`. The literal narrows the body type for
 *     `hc<AppType>` without an `as` assertion.
 *
 * **Route-local response schema.** Health is infrastructure, not a
 * capability, so there is no shared `@editorzero/schemas` source to
 * reuse — the wire shape lives here, the one place it is used (the
 * reuse-don't-redeclare rule in ADR 0034 governs *capability* schemas,
 * which have a kernel source; this has none).
 *
 * The route mounts at a path **relative** to its domain (`/health`); the
 * `infra` domain mounts at `/infra` on the trunk, so the external path
 * is `/infra/health`. `hc<AppType>` reconstructs `client.infra.health.$get`.
 */

import { Hono } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../../env";
import { describeRoute, factory, jsonContent } from "../../lib/openapi";

const HealthResponse = z.object({ status: z.literal("ok"), now: z.number().int() });

export const health = new Hono<ApiEnv>().get(
  "/health",
  ...factory.createHandlers(
    describeRoute({
      tags: ["infra"],
      summary: "Liveness probe.",
      responses: {
        200: { description: "OK", content: jsonContent(HealthResponse) },
      },
    }),
    (c) => c.json({ status: "ok", now: Date.now() } as const, 200),
  ),
);
