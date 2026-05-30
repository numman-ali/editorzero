/**
 * `audit` domain sub-app.
 *
 * Composes the audit-read routes (`get`, `list`) into one
 * `Hono<ApiEnv>` via a chained `.route("/", subApp)` chain. The trunk
 * mounts it at the **plural** prefix — `trunk.route("/audits", audit)`
 * — so `/get/:audit_id` becomes `/audits/get/:audit_id` (the dir is
 * singular `audit/`, the external prefix is `/audits`; preserved from
 * the prior tuple wiring). Mirrors the `routes/docs/` sub-app; see that
 * header for the chained-`.route()` RPC-merge rationale (ADR 0029).
 * Middleware for `/audits/*` is attached at the trunk, not here.
 */

import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { get } from "./get";
import { list } from "./list";

export const audit = new Hono<ApiEnv>().route("/", get).route("/", list);
