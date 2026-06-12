/**
 * `spaces` domain sub-app.
 *
 * Composes every capability route under `routes/spaces/*.ts` into one
 * `Hono<ApiEnv>` via a chained `.route("/", subApp)` chain; the trunk
 * mounts it with `trunk.route("/spaces", spaces)`, so a route's
 * `/create` becomes `/spaces/create`. Mirrors the `routes/docs/`
 * sub-app — see that header for the chained-`.route()` RPC-merge
 * rationale (ADR 0029). Middleware for `/spaces/*` is attached at the
 * trunk, not here.
 */

import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { archive } from "./archive";
import { create } from "./create";
import { get } from "./get";
import { list } from "./list";
import { memberAdd } from "./member_add";
import { memberRemove } from "./member_remove";
import { memberUpdateRole } from "./member_update_role";
import { restore } from "./restore";
import { update } from "./update";

export const spaces = new Hono<ApiEnv>()
  .route("/", archive)
  .route("/", create)
  .route("/", get)
  .route("/", list)
  .route("/", memberAdd)
  .route("/", memberRemove)
  .route("/", memberUpdateRole)
  .route("/", restore)
  .route("/", update);
