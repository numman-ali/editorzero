/**
 * `GET /permissions/list` — permission.list surface (invariant 4).
 * Code-first shape (ADR 0029); mirrors `workspaces/member_list.ts`
 * (the paginated-read sibling).
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `PermissionListInputSchema` / `PermissionListOutputSchema` from
 * `@editorzero/schemas/permission/list`; the query string's numeric
 * params coerce through the shared schema's `z.coerce.number()`.
 *
 * **Status — 200 OK.** One page of the resource's ACL edges (guest
 * edges included — the access panel surfaces the audited escape
 * hatches), `next_cursor: null` on the last page.
 *
 * **400 — `validation_failed`.** Malformed query — unknown kind,
 * non-UUIDv7 resource_id / before_grant_id, or a mismatched cursor
 * pair.
 *
 * **404 — `not_found`.** Resource missing or soft-deleted (trash-
 * invisible read posture; restore first).
 *
 * **403 — `permission_denied`.** Caller lacks `workspace:read`, or
 * the visibility rule denied: doc → caller cannot read the doc;
 * space → caller has neither baseline reach nor granting authority.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  PermissionListInputSchema,
  PermissionListOutputSchema,
} from "@editorzero/schemas/permission/list";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const PERMISSION_LIST_ID = CapabilityId("permission.list");

export const list = new Hono<ApiEnv>().get(
  "/list",
  ...factory.createHandlers(
    describeRoute({
      tags: ["permissions"],
      summary: "List the ACL edges on a doc or space; paginated, visibility-gated.",
      responses: {
        200: {
          description:
            "One page of grant rows on the resource (guest edges included), newest first; `next_cursor` is null on the last page.",
          content: jsonContent(PermissionListOutputSchema),
        },
        400: {
          description:
            "Validation error — unknown resource_kind, non-UUIDv7 ids, or a mismatched cursor pair.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description:
            "Permission denied — missing `workspace:read`, or the visibility rule denied (doc: cannot read; space: neither reach nor authority).",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Resource missing or soft-deleted (trash-invisible).",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("query", PermissionListInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("query");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: PERMISSION_LIST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(PermissionListOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
