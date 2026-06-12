/**
 * `POST /spaces/member_remove/:space_id` — space.member_remove surface
 * (invariant 4).
 *
 * Code-first route (ADR 0029 / 0034): path param `space_id` + JSON
 * body `{user_id}` merged into the capability input (the P3 split —
 * see `member_add.ts`).
 *
 * **Status codes.**
 *   200 — removed; the echo is the FULL preimage (`role` included) —
 *         `space_members` is hard-DELETE, so this body and the audit
 *         row are the only durable records of the membership.
 *   400 — malformed body.
 *   401 — unauthenticated.
 *   403 — permission denied (the administer ladder).
 *   404 — space missing/trashed, OR the target is not on the roster
 *         (stale-view signal — remove is not idempotent).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  SpaceMemberRemoveBodySchema,
  SpaceMemberRemoveOutputSchema,
  SpaceMemberRemoveParamSchema,
} from "@editorzero/schemas/space/member_remove";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const SPACE_MEMBER_REMOVE_ID = CapabilityId("space.member_remove");

export const memberRemove = new Hono<ApiEnv>().post(
  "/member_remove/:space_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "Remove a member from a space (hard delete; the echo is the preimage).",
      responses: {
        200: {
          description:
            "Member removed — the echo carries the full preimage (the row is hard-deleted).",
          content: jsonContent(SpaceMemberRemoveOutputSchema),
        },
        400: {
          description: "Validation error — malformed body.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller cannot administer the space.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Space not found (or trashed), or the target is not on the roster.",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("param", SpaceMemberRemoveParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", SpaceMemberRemoveBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_MEMBER_REMOVE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceMemberRemoveOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
