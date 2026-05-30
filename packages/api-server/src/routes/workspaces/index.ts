/**
 * `workspaces` domain sub-app.
 *
 * Composes every capability route under `routes/workspaces/*.ts` into
 * one `Hono<ApiEnv>` via a chained `.route("/", subApp)` chain; the
 * trunk mounts it with `trunk.route("/workspaces", workspaces)`, so a
 * route's `/member_add` becomes `/workspaces/member_add`. Mirrors the
 * `routes/docs/` sub-app — see that header for the chained-`.route()`
 * RPC-merge rationale (ADR 0029). Middleware for `/workspaces/*` is
 * attached at the trunk, not here.
 */

import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { get } from "./get";
import { memberAdd } from "./member_add";
import { memberList } from "./member_list";
import { memberRemove } from "./member_remove";
import { memberUpdateRole } from "./member_update_role";
import { update } from "./update";

export const workspaces = new Hono<ApiEnv>()
  .route("/", get)
  .route("/", memberAdd)
  .route("/", memberList)
  .route("/", memberRemove)
  .route("/", memberUpdateRole)
  .route("/", update);
