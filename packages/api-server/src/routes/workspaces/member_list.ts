/**
 * `GET /workspaces/member_list` — workspace.member_list surface
 * (invariant 4). Code-first shape (ADR 0029); reuses the shared wire
 * schema (ADR 0034). Mirror `routes/docs/create.ts` for the canonical
 * three-handler form.
 *
 * **Pattern P4 — query string → capability input.** `limit`,
 * `before_created_at`, `before_user_id`, and `role` live on the URL.
 * `WorkspaceMemberListInputSchema` already uses `z.coerce.number()` on its
 * numeric fields (it validates HTTP query strings as well as CLI/MCP
 * numeric args), so the route feeds it straight to `validator("query", …)`:
 * `c.req.valid("query")` hands the handler the parsed, branded
 * `InferOutput`, and the OpenAPI request is generated from the same schema
 * — no wire copy to drift (the both-or-neither cursor refine and the
 * `.strict()` unknown-key rejection ride along automatically, the drift
 * class Codex flagged on `doc.update`).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` (the
 * `user | agent` union — capability routes serve agents too, invariant 8);
 * the handler reads `workspace_id` (on both arms) and forwards the
 * principal to the dispatcher. `dispatch` returns `Promise<unknown>`; the
 * handler *parses* it through `WorkspaceMemberListOutputSchema` rather than
 * asserting — the honest `unknown`→typed narrowing and a runtime guard
 * that dispatcher output still satisfies the published contract.
 *
 * **Scope.** `workspace:admin` — the capability refuses other callers at
 * the dispatcher gate. The route declares 403 so the OpenAPI doc carries
 * the contract; 401 is declaration-only (the principal middleware returns
 * it cross-cuttingly, not this handler).
 *
 * The route mounts relative to its domain (`/member_list`); the
 * `workspaces` domain mounts at `/workspaces`, so the external path is
 * `/workspaces/member_list`.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  WorkspaceMemberListInputSchema,
  WorkspaceMemberListOutputSchema,
} from "@editorzero/schemas/workspace/member_list";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const WORKSPACE_MEMBER_LIST_ID = CapabilityId("workspace.member_list");

export const memberList = new Hono<ApiEnv>().get(
  "/member_list",
  ...factory.createHandlers(
    describeRoute({
      tags: ["workspaces"],
      summary: "List active workspace members; paginated, admin-only.",
      responses: {
        200: {
          description: "Page of members with an optional next-page cursor.",
          content: jsonContent(WorkspaceMemberListOutputSchema),
        },
        400: {
          description: "Validation error — mismatched cursor pair or invalid role filter.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `workspace:admin`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
      },
    }),
    validator("query", WorkspaceMemberListInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("query");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: WORKSPACE_MEMBER_LIST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(WorkspaceMemberListOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
