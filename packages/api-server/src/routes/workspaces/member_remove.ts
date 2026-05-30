/**
 * `POST /workspaces/member_remove` — workspace.member_remove surface
 * (invariant 4). Code-first shape (ADR 0029); see `docs/create.ts` for the
 * canonical walk-through of the three-handler `factory.createHandlers`
 * chain (describeRoute → validator + hook → dispatch handler) and the
 * zero-`as`, parse-don't-assert discipline this route follows.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `WorkspaceMemberRemoveInputSchema` / `WorkspaceMemberRemoveOutputSchema`
 * from `@editorzero/schemas/workspace/member_remove` are the single source
 * the capability also consumes. `validator("json", …Input…)` types the
 * `hc` request body as the wire shape (plain `user_id` string) and hands
 * the handler the branded `InferOutput`; `WorkspaceMemberRemoveOutputSchema.parse`
 * narrows the dispatcher's `unknown` output to the published response.
 *
 * Metadata-only mutation. Soft-deletes a workspace membership; scope
 * `workspace:admin`. Body carries `{ user_id }` — not a path param,
 * because the domain's `<domain>_id` convention belongs to `workspace_id`,
 * and this capability targets the ambient workspace (pinned via principal).
 *
 * **Status — 200 OK** (soft-delete, not create). Echoes
 * `{workspace_id, user_id, deleted_at}`.
 *
 * **Not idempotent.** Removing an already-removed member is a 404 — the
 * signal that the caller tried to remove someone who was never there or
 * was already removed by another admin is preserved, not swallowed.
 *
 * **409 Conflict — `last_owner_protected`.** Removing the only live owner
 * would leave the workspace ownerless; `LastOwnerError` surfaces as 409 via
 * `errorResponse`. A PG serializable race that loses at commit surfaces as
 * `conflict` (same invariant family, transient). Self-removal is allowed —
 * the last-owner guard blocks only the dangerous case (an owner cannot
 * leave until another owner exists), preserving the "no ownerless
 * workspace" invariant.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  WorkspaceMemberRemoveInputSchema,
  WorkspaceMemberRemoveOutputSchema,
} from "@editorzero/schemas/workspace/member_remove";
import { Hono } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const WORKSPACE_MEMBER_REMOVE_ID = CapabilityId("workspace.member_remove");

export const memberRemove = new Hono<ApiEnv>().post(
  "/member_remove",
  ...factory.createHandlers(
    describeRoute({
      tags: ["workspaces"],
      summary: "Remove a member from the workspace; metadata-only, admin-only.",
      responses: {
        200: {
          description: "Member soft-deleted — deleted_at anchors the removal.",
          content: jsonContent(WorkspaceMemberRemoveOutputSchema),
        },
        400: {
          description: "Validation error — missing/empty user_id or unknown body key.",
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
        404: {
          description: "Target user has no live membership row in the caller's workspace.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "Removal blocked — `last_owner_protected` when the target is the only live owner; `conflict` when a PG serializable race loses at commit (same invariant family, transient).",
          content: jsonContent(z.object({ error: z.enum(["last_owner_protected", "conflict"]) })),
        },
      },
    }),
    validator("json", WorkspaceMemberRemoveInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("json");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: WORKSPACE_MEMBER_REMOVE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(WorkspaceMemberRemoveOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
