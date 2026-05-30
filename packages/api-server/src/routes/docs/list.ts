/**
 * `GET /docs/list` — list all non-deleted docs in the caller's workspace.
 *
 * **Code-first route shape (ADR 0029); empty-input variant.** Like the
 * golden `create` route, this is a self-contained `Hono<ApiEnv>` sub-app
 * built from chained handlers via `factory.createHandlers(...)`. It
 * differs in one axis: `doc.list` takes **no request input** in v1, so
 * there is no `validator(...)` arm — the capability input is the empty
 * object `{}`, minted by the handler rather than parsed from the request:
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (summary, tags,
 *      per-status response schemas). Documents the contract; does not
 *      feed `hc`.
 *   2. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches `doc.list` with `input: {}`, and returns the
 *      dispatcher's output through `c.json`. The dispatcher *throws*
 *      `EditorZeroError` subclasses; the handler catches and maps them
 *      with `errorResponse(c, err)` to explicit, literal-typed `c.json`
 *      returns — those explicit returns are what `hc<AppType>` reads to
 *      infer the error arm (ADR 0029 §4). There is no 400 arm here: with
 *      no request body to validate, the only client-visible errors are
 *      the cross-cutting 401 (principal middleware) and the dispatcher's
 *      403.
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` — the
 * `user | agent` union. Capability routes serve agent principals too
 * (invariant 8); the handler only reads `workspace_id` (present on both
 * arms) and forwards `principal` to the dispatcher (which accepts the
 * union). `dispatch` returns `Promise<unknown>`; rather than *assert* a
 * type with `as`, the handler *parses* that `unknown` through the
 * capability's shared response schema (`DocListOutputSchema.parse`) — the
 * honest `unknown`→typed narrowing, and a runtime guard that the
 * dispatcher output still satisfies the published contract (a drift
 * surfaces as a ZodError → 500, not a silent lie).
 *
 * The route mounts at a path **relative** to its domain (`/list`); the
 * `docs` domain mounts at `/docs` on the trunk, so the external path is
 * `/docs/list`. `hc<AppType>` reconstructs `client.docs.list.$get`.
 *
 * **Response schema — reused, not re-declared (ADR 0034).**
 * `DocListOutputSchema` from `@editorzero/schemas/doc/list` is the single
 * source the capability also consumes. Its `*OutputSchema` transforms
 * re-brand IDs, but `resolver` / `describeRoute` generate the OpenAPI
 * response from the *input* side, so the spec stays wire-shaped (branded
 * IDs invisible to external clients). No wire copy drifts from the
 * capability because there is no copy — the migration's whole point.
 *
 * **Audit + permission gate live inside the dispatcher**, not here
 * (invariant 5). A capability that reaches this handler has already
 * passed the gate; the dispatcher writes its audit row after dispatch.
 */

import { CapabilityId } from "@editorzero/ids";
import { DocListOutputSchema } from "@editorzero/schemas/doc/list";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent } from "../../lib/openapi";

const DOC_LIST_ID = CapabilityId("doc.list");

export const list = new Hono<ApiEnv>().get(
  "/list",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "List all non-deleted docs in the caller's workspace.",
      responses: {
        200: {
          description: "Docs list.",
          content: jsonContent(DocListOutputSchema),
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
          capability_id: DOC_LIST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocListOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
