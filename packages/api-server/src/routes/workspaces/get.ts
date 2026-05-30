/**
 * `GET /workspaces/get` — read the caller's workspace metadata (slug,
 * name, retention, settings).
 *
 * **Code-first shape (ADR 0029), P0EMPTY variant.** Like the golden
 * `docs/create`, this is a self-contained `Hono<ApiEnv>` sub-app built
 * from chained handlers via `factory.createHandlers(...)`. It differs in
 * one way: `workspace.get` takes **no request input** — the principal
 * already carries `workspace_id`, so its capability input is the empty
 * object. There is **no `validator`** in the chain (no body / param /
 * query to parse, hence no 400 `validation_failed` arm), and the handler
 * synthesises `const input = {}` itself rather than reading
 * `c.req.valid(...)`.
 *
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (summary, tags,
 *      per-status response schemas). Documents the contract; does not
 *      feed `hc`.
 *   2. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches `workspace.get` with the empty input, and returns the
 *      dispatcher's output through `c.json` at 200. The dispatcher
 *      *throws* `EditorZeroError` subclasses; the handler catches and maps
 *      them with `errorResponse(c, err)` to explicit, literal-typed
 *      `c.json` returns — those explicit returns are what `hc<AppType>`
 *      reads to infer the error arm (ADR 0029 §4). Beyond the cross-cutting
 *      401 (principal middleware) and the dispatcher's 403, the one
 *      capability-specific arm is 404: the workspace can be soft-deleted or
 *      missing (a bootstrap gap).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` — the
 * `user | agent` union. Capability routes serve agent principals too
 * (invariant 8); the handler only reads `workspace_id` (present on both
 * arms) and forwards `principal` to the dispatcher. `dispatch` returns
 * `Promise<unknown>`; rather than *assert* a type with `as`, the handler
 * *parses* that `unknown` through the capability's shared response schema
 * (`WorkspaceGetOutputSchema.parse`) — the honest `unknown`→typed
 * narrowing, and a runtime guard that the dispatcher output still
 * satisfies the published contract (a drift surfaces as a ZodError → 500,
 * not a silent lie).
 *
 * The route mounts at a path **relative** to its domain (`/get`); the
 * `workspaces` domain mounts at `/workspaces` on the trunk, so the
 * external path is `/workspaces/get`. `hc<AppType>` reconstructs
 * `client.workspaces.get.$get`. The `/get` suffix matches the repo-wide
 * `<plural>/<action>` convention (`apps/cli` derives HTTP bindings from
 * the capability id via this rule).
 *
 * **Response schema — reused, not re-declared (ADR 0034).**
 * `WorkspaceGetOutputSchema` from `@editorzero/schemas/workspace/get` is
 * the single source the capability also consumes. `resolver` /
 * `describeRoute` generate the OpenAPI response from it (wire-shaped:
 * branded IDs serialize as plain strings, brands invisible to external
 * clients). No wire copy drifts from the capability because there is no
 * copy — the migration's whole point.
 *
 * **Audit + permission gate live inside the dispatcher**, not here
 * (invariant 5). A capability that reaches this handler has already passed
 * the gate.
 */

import { CapabilityId } from "@editorzero/ids";
import { WorkspaceGetOutputSchema } from "@editorzero/schemas/workspace/get";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent } from "../../lib/openapi";

const WORKSPACE_GET_ID = CapabilityId("workspace.get");

export const get = new Hono<ApiEnv>().get(
  "/get",
  ...factory.createHandlers(
    describeRoute({
      tags: ["workspaces"],
      summary: "Read the caller's workspace metadata.",
      responses: {
        200: {
          description: "The caller's workspace.",
          content: jsonContent(WorkspaceGetOutputSchema),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `workspace:read`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Workspace is soft-deleted or missing (bootstrap gap).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    async (c) => {
      const principal = c.var.principal;
      const input = {};
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: WORKSPACE_GET_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(WorkspaceGetOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
