/**
 * `infra` domain sub-app.
 *
 * Composes the infrastructure routes (`health` — public liveness;
 * `whoami` — auth-gated principal orientation, ADR 0025) into one
 * `Hono<ApiEnv>` via a chained `.route("/", subApp)` chain. The trunk
 * mounts it with `trunk.route("/infra", infra)`, so `/health` becomes
 * `/infra/health`. Non-capability endpoints live under `infra/`
 * precisely so they are visibly not capability endpoints.
 *
 * Mirrors the `routes/docs/` sub-app — see that header for the chained-
 * `.route()` RPC-schema-merge rationale (ADR 0029). `/infra/health`
 * mounts no principal middleware (public probe); `/infra/whoami` is
 * gated by the trunk's exact-path principal mount.
 */

import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { health } from "./health";
import { whoami } from "./whoami";

export const infra = new Hono<ApiEnv>().route("/", health).route("/", whoami);
