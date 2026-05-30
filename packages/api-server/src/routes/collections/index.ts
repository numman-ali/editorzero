/**
 * `collections` domain sub-app.
 *
 * Composes every capability route under `routes/collections/*.ts` into
 * one `Hono<ApiEnv>` via a chained `.route("/", subApp)` chain; the
 * trunk mounts it with `trunk.route("/collections", collections)`, so a
 * route's `/create` becomes `/collections/create`. Mirrors the
 * `routes/docs/` sub-app exactly — see that aggregator's header for the
 * rationale on chained `.route()` RPC-schema merging (ADR 0029) and the
 * "add a capability → add one `.route()` link" workflow.
 *
 * Middleware (`createPrincipalMiddleware` + `createDispatcherMiddleware`)
 * is mounted at the trunk on the `/collections/*` prefix, not here.
 */

import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { create } from "./create";
import { del } from "./delete";
import { list } from "./list";
import { move } from "./move";
import { restore } from "./restore";
import { update } from "./update";

export const collections = new Hono<ApiEnv>()
  .route("/", list)
  .route("/", create)
  .route("/", update)
  .route("/", move)
  .route("/", del)
  .route("/", restore);
