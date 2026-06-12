/**
 * `POST /spaces/member_add/:space_id` — space.member_add surface
 * (invariant 4).
 *
 * Code-first route (ADR 0029 / 0034): the path param carries the
 * domain id (`space_id` — the derived-binding convention the parity
 * matrix enforces), the JSON body carries `{user_id, role}`, and the
 * two halves merge into the capability input (the `space.update` P3
 * split — Param/Body schemas derived from the same base object).
 *
 * **Status codes.**
 *   200 — member added; echoes the full row.
 *   400 — schema failure, the personal-roster refusal
 *         (`personal_space_membership_pinned`), or the subject-standing
 *         refusal (`subject_not_workspace_member` → run
 *         `workspace.member_add` first). The two typed refusals surface
 *         as `validation` envelopes from the dispatcher.
 *   401 — unauthenticated.
 *   403 — permission denied (the administer ladder).
 *   404 — space missing or trashed.
 *   409 — `member_already_exists` (the target is on the roster; role
 *         changes flow through space.member_update_role).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  SpaceMemberAddBodySchema,
  SpaceMemberAddOutputSchema,
  SpaceMemberAddParamSchema,
} from "@editorzero/schemas/space/member_add";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const SPACE_MEMBER_ADD_ID = CapabilityId("space.member_add");

export const memberAdd = new Hono<ApiEnv>().post(
  "/member_add/:space_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["spaces"],
      summary: "Add a member to a team space; the role confers baseline reach.",
      responses: {
        200: {
          description: "Member added — echoes the full roster row.",
          content: jsonContent(SpaceMemberAddOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed body, a personal space's pinned roster " +
            "(`personal_space_membership_pinned`), or a subject without live workspace " +
            "membership (`subject_not_workspace_member`).",
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
          description: "Space not found (or trashed).",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "The target is already on the roster — role changes flow through " +
            "space.member_update_role.",
          content: jsonContent(errEnvelope("member_already_exists")),
        },
      },
    }),
    validator("param", SpaceMemberAddParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", SpaceMemberAddBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: SPACE_MEMBER_ADD_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(SpaceMemberAddOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
