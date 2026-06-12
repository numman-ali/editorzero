/**
 * `POST /spaces/member_update_role/:space_id` —
 * space.member_update_role surface (invariant 4).
 *
 * Code-first route (ADR 0029 / 0034): path param `space_id` + JSON
 * body `{user_id, role}` merged into the capability input (the P3
 * split — see `member_add.ts`).
 *
 * **Status codes.**
 *   200 — role changed; echoes the row (`created_at` untouched).
 *   400 — malformed body, or `role_unchanged` (re-asserting the current
 *         role — a success would mint a meaningless audit row).
 *   401 — unauthenticated.
 *   403 — permission denied (the administer ladder).
 *   404 — space missing/trashed, or the target is not on the roster.
 *   409 — `conflict`: the member's role changed concurrently (the
 *         UPDATE re-predicates on the role read in the pre-check).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  SpaceMemberUpdateRoleBodySchema,
  SpaceMemberUpdateRoleOutputSchema,
  SpaceMemberUpdateRoleParamSchema,
} from "@editorzero/schemas/space/member_update_role";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const SPACE_MEMBER_UPDATE_ROLE_ID = CapabilityId("space.member_update_role");

export const memberUpdateRole = new Hono<ApiEnv>().post(
  "/member_update_role/:space_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "Change a space member's role (baseline reach tier).",
      responses: {
        200: {
          description: "Role changed — echoes the row.",
          content: jsonContent(SpaceMemberUpdateRoleOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed body, or `role_unchanged` (the member already " +
            "holds that role).",
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
        409: {
          description: "The member's role changed concurrently — re-read the roster.",
          content: jsonContent(errEnvelope("conflict")),
        },
      },
    }),
    validator("param", SpaceMemberUpdateRoleParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", SpaceMemberUpdateRoleBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_MEMBER_UPDATE_ROLE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceMemberUpdateRoleOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
