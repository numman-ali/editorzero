/**
 * `POST /workspaces/member_update_role` — workspace.member_update_role
 * surface (invariant 4).
 *
 * Metadata-only mutation. Changes a member's role; scope
 * `workspace:admin`. Body carries `{ user_id, role }` — `user_id` is
 * not a path param because the domain's `<domain>_id` convention
 * belongs to `workspace_id` (target thing in the URL), and this
 * capability targets the ambient workspace (pinned via principal).
 * The `deriveHttpBinding` rule (`apps/cli/src/generator/http-
 * binding.ts`) produces the same shape.
 *
 * **Status — 200 OK** (update, not create). Echoes `{workspace_id,
 * user_id, role, updated_at}` so callers don't need a follow-up list.
 *
 * **409 Conflict — `last_owner_protected`.** Demoting the only live
 * owner would leave the workspace ownerless; `LastOwnerError` surfaces
 * as 409 via the dispatcher's error projector. The check + UPDATE run
 * inside the write-path tx (`METADATA_ONLY_CAPABILITIES` membership
 * gives a tx-bound `ctx.db`), so a concurrent demote-the-other-owner
 * cannot slip through (see capability doc-block).
 *
 * **400 `role_unchanged`.** Re-asserting the target's current role is
 * rejected inside the handler (prevents no-op audit rows). Raised as
 * `ValidationError` with issue code `role_unchanged`.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { ROLES } from "@editorzero/scopes";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const WORKSPACE_MEMBER_UPDATE_ROLE_ID = CapabilityId("workspace.member_update_role");

const UpdateRoleRequest = z
  .object({
    user_id: z.string().min(1, "user_id must not be empty"),
    role: z.enum(ROLES),
  })
  .strict()
  .openapi("WorkspaceMemberUpdateRoleRequest");

const UpdateRoleResponse = z
  .object({
    workspace_id: z.string(),
    user_id: z.string(),
    role: z.enum(ROLES),
    updated_at: z.number(),
  })
  .openapi("WorkspaceMemberUpdateRoleResponse");

const memberUpdateRoleRouteDef = createRoute({
  method: "post",
  path: "/workspaces/member_update_role",
  tags: ["workspaces"],
  summary: "Change a workspace member's role; metadata-only, admin-only.",
  request: {
    body: {
      content: { "application/json": { schema: UpdateRoleRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Role updated — post-patch metadata.",
      content: { "application/json": { schema: UpdateRoleResponse } },
    },
    400: {
      description:
        "Validation error — missing user_id, unknown role, unknown body key, or target already has the asserted role (`role_unchanged`).",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("validation") }),
        },
      },
    },
    401: {
      description: "Unauthenticated.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("unauthenticated") }),
        },
      },
    },
    403: {
      description: "Permission denied — caller lacks `workspace:admin`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
    404: {
      description: "No live membership row for the target user_id in the caller's workspace.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description:
        "Demote blocked — target is the only live owner; last-owner invariant would be broken.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("conflict") }),
        },
      },
    },
  },
});

export const memberUpdateRole = defineOpenAPIRoute<typeof memberUpdateRoleRouteDef, ApiEnv, true>({
  route: memberUpdateRoleRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const body = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: WORKSPACE_MEMBER_UPDATE_ROLE_ID,
      input: body,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof UpdateRoleResponse>, 200);
  },
  addRoute: true,
});
