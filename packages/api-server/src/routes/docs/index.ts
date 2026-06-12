/**
 * `docs` domain sub-app.
 *
 * Composes every capability route under `routes/docs/<capability>.ts`
 * into one `Hono<ApiEnv>` via a chained `.route("/", subApp)` fluent
 * chain. The trunk (`src/app.ts`) mounts this whole sub-app once with
 * `trunk.route("/docs", docs)`, so each route's relative path
 * (`/create`, `/get/:doc_id`, …) becomes its external path
 * (`/docs/create`, `/docs/get/:doc_id`). Per-route unit tests live
 * co-located at `<capability>.unit.test.ts`; this `index.ts` is the
 * only one per domain — it is the grouping aggregator, not a route.
 *
 * **Why a chained `.route()` and not a tuple (ADR 0029).** Each route
 * module is a self-contained `Hono` sub-app built from
 * `factory.createHandlers(describeRoute, validator, handler)`. Base
 * Hono's `.route()` merges each mounted sub-app's RPC `Schema` into the
 * parent's return type, and the fluent chain accumulates the union —
 * so `hc<AppType>` reconstructs `client.docs.create.$post` etc. through
 * the two-level mount. The chain must stay a single fluent expression:
 * assigning an intermediate to a `const` and re-mounting it works at
 * runtime but is the shape most prone to widening the inferred schema,
 * so keep the links contiguous. (The prior `@hono/zod-openapi`
 * `openapiRoutes([...] as const)` tuple existed only because
 * `OpenAPIHono.route()` did *not* merge the OpenAPI registry across
 * sub-apps; the code-first substrate has no such limitation — ADR
 * 0029 reverses that choice.)
 *
 * **OpenAPI.** Each route carries its `describeRoute` metadata on the
 * mounted handler; `generateSpecs(app)` (in `app.ts`) walks the trunk's
 * routes statically and emits `/docs/<capability>` from this mount —
 * no per-domain spec wiring here.
 *
 * **Adding a capability.** Create `routes/docs/<name>.ts` exporting a
 * `Hono<ApiEnv>` sub-app (one `.METHOD("/<name>", ...factory.create
 * Handlers(...))`) plus its sibling `<name>.unit.test.ts`; import it
 * here and add one `.route("/", <name>)` link. The trunk needs no
 * change.
 *
 * **Middleware is mounted at the trunk**, not here. The trunk factory
 * (`createApiApp`) attaches `createPrincipalMiddleware` +
 * `createDispatcherMiddleware` on the `/docs/*` prefix. Every route
 * here expects those to have run before its handler reads
 * `c.var.principal` / `c.var.dispatcher`.
 */

import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { addGuest } from "./add_guest";
import { create } from "./create";
import { del } from "./delete";
import { get } from "./get";
import { list } from "./list";
import { move } from "./move";
import { publish } from "./publish";
import { removeGuest } from "./remove_guest";
import { rename } from "./rename";
import { restore } from "./restore";
import { unpublish } from "./unpublish";
import { update } from "./update";

export const docs = new Hono<ApiEnv>()
  .route("/", list)
  .route("/", create)
  .route("/", get)
  .route("/", publish)
  .route("/", unpublish)
  .route("/", del)
  .route("/", restore)
  .route("/", rename)
  .route("/", update)
  .route("/", move)
  .route("/", addGuest)
  .route("/", removeGuest);
