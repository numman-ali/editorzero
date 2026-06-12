/**
 * `permissions` domain sub-app.
 *
 * Composes every capability route under `routes/permissions/*.ts` into
 * one `Hono<ApiEnv>` via a chained `.route("/", subApp)` chain; the
 * trunk mounts it with `trunk.route("/permissions", permissions)`, so a
 * route's `/grant` becomes `/permissions/grant`. Mirrors the
 * `routes/docs/` sub-app — see that header for the chained-`.route()`
 * RPC-merge rationale (ADR 0029). Middleware for `/permissions/*` is
 * attached at the trunk, not here.
 */

import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { grant } from "./grant";
import { revoke } from "./revoke";

export const permissions = new Hono<ApiEnv>().route("/", grant).route("/", revoke);
