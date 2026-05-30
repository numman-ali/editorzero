/**
 * `GET /collections/list` — list every non-deleted collection in the
 * caller's workspace.
 *
 * **Code-first shape (ADR 0029), P0EMPTY variant.** Like the golden
 * `docs/create`, this is a self-contained `Hono<ApiEnv>` sub-app built
 * from chained handlers via `factory.createHandlers(...)`. It differs in
 * one way: `collection.list` takes **no request input** (its capability
 * input is the empty object). So there is **no `validator`** in the
 * chain — there is no body / param / query to parse, hence no 400
 * `validation_failed` arm, and the handler synthesises `const input = {}`
 * itself rather than reading `c.req.valid(...)`.
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (summary, tags,
 *      per-status response schemas). Documents the contract; does not
 *      feed `hc`.
 *   2. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches `collection.list` with the empty input, and returns the
 *      dispatcher's output through `c.json` at 200. The dispatcher
 *      *throws* `EditorZeroError` subclasses; the handler catches and maps
 *      them with `errorResponse(c, err)` to explicit, literal-typed
 *      `c.json` returns — those explicit returns are what `hc<AppType>`
 *      reads to infer the error arm (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` — the
 * `user | agent` union. Capability routes serve agent principals too
 * (invariant 8); the handler only reads `workspace_id` (present on both
 * arms) and forwards `principal` to the dispatcher. `dispatch` returns
 * `Promise<unknown>`; rather than *assert* a type with `as`, the handler
 * *parses* that `unknown` through the capability's shared response schema
 * (`CollectionListOutputSchema.parse`) — the honest `unknown`→typed
 * narrowing, and a runtime guard that the dispatcher output still
 * satisfies the published contract (a drift surfaces as a ZodError → 500,
 * not a silent lie).
 *
 * The route mounts at a path **relative** to its domain (`/list`); the
 * `collections` domain mounts at `/collections` on the trunk, so the
 * external path is `/collections/list`. `hc<AppType>` reconstructs
 * `client.collections.list.$get`.
 *
 * **Response schema — reused, not re-declared (ADR 0034).**
 * `CollectionListOutputSchema` from `@editorzero/schemas/collection/list`
 * is the single source the capability also consumes. `resolver` /
 * `describeRoute` generate the OpenAPI response from it (wire-shaped:
 * branded IDs serialize as plain strings, brands invisible to external
 * clients). No wire copy drifts from the capability because there is no
 * copy.
 *
 * **Audit + permission gate live inside the dispatcher**, not here.
 */

import { CapabilityId } from "@editorzero/ids";
import { CollectionListOutputSchema } from "@editorzero/schemas/collection/list";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent } from "../../lib/openapi";

const COLLECTION_LIST_ID = CapabilityId("collection.list");

export const list = new Hono<ApiEnv>().get(
  "/list",
  ...factory.createHandlers(
    describeRoute({
      tags: ["collections"],
      summary: "List all non-deleted collections in the caller's workspace.",
      responses: {
        200: {
          description: "Collections list.",
          content: jsonContent(CollectionListOutputSchema),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
      },
    }),
    async (c) => {
      const principal = c.var.principal;
      const input = {};
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: COLLECTION_LIST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(CollectionListOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
