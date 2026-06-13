/**
 * `agents` domain sub-app (ADR 0044).
 *
 * Composes every capability route under `routes/agents/*.ts` into one
 * `Hono<ApiEnv>` via a chained `.route("/", subApp)` chain; the trunk
 * mounts it with `trunk.route("/agents", agents)`, so a route's
 * `/create` becomes `/agents/create`. Mirrors the `routes/spaces/`
 * sub-app — see `routes/docs/index.ts` for the chained-`.route()`
 * RPC-merge rationale (ADR 0029). Middleware for `/agents/*` is
 * attached at the trunk, not here.
 */

import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { create } from "./create";
import { get } from "./get";
import { list } from "./list";
import { revoke } from "./revoke";
import { tokenList } from "./token_list";
import { tokenMint } from "./token_mint";
import { tokenRevoke } from "./token_revoke";
import { update } from "./update";

export const agents = new Hono<ApiEnv>()
  .route("/", create)
  .route("/", get)
  .route("/", list)
  .route("/", revoke)
  .route("/", tokenList)
  .route("/", tokenMint)
  .route("/", tokenRevoke)
  .route("/", update);
