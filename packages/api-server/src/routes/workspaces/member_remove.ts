/**
 * `POST /workspaces/member_remove` — workspace.member_remove surface
 * (invariant 4).
 *
 * Metadata-only mutation. Soft-deletes a workspace membership; scope
 * `workspace:admin`. Body carries `{ user_id }` — not a path param
 * because the domain's `<domain>_id` convention belongs to
 * `workspace_id`, and this capability targets the ambient workspace
 * (pinned via principal). The `deriveHttpBinding` rule (`apps/cli/src/
 * generator/http-binding.ts`) produces the same shape.
 *
 * **Status — 200 OK** (soft-delete, not create). Echoes
 * `{workspace_id, user_id, deleted_at}`.
 *
 * **Not idempotent.** Removing an already-removed member is a 404.
 * Idempotency would swallow the signal that the caller tried to remove
 * someone who was never there or was already removed by another admin
 * (see capability doc-block).
 *
 * **409 Conflict — `last_owner_protected`.** Removing the only live
 * owner would leave the workspace ownerless; `LastOwnerError` surfaces
 * as 409 via the dispatcher's error projector. The check + UPDATE run
 * inside the write-path tx for COUNT+UPDATE atomicity.
 *
 * **Self-removal is allowed.** The last-owner guard naturally blocks
 * the dangerous case (owner cannot leave until another owner exists),
 * preserving the "no ownerless workspace" invariant.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const WORKSPACE_MEMBER_REMOVE_ID = CapabilityId("workspace.member_remove");

const RemoveRequest = z
  .object({
    user_id: z.string().min(1, "user_id must not be empty"),
  })
  .strict()
  .openapi("WorkspaceMemberRemoveRequest");

const RemoveResponse = z
  .object({
    workspace_id: z.string(),
    user_id: z.string(),
    deleted_at: z.number(),
  })
  .openapi("WorkspaceMemberRemoveResponse");

const memberRemoveRouteDef = createRoute({
  method: "post",
  path: "/workspaces/member_remove",
  tags: ["workspaces"],
  summary: "Remove a member from the workspace; metadata-only, admin-only.",
  request: {
    body: {
      content: { "application/json": { schema: RemoveRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Member soft-deleted — deleted_at anchors the removal.",
      content: { "application/json": { schema: RemoveResponse } },
    },
    400: {
      description: "Validation error — missing user_id or unknown body key.",
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
      description: "Target user has no live membership row in the caller's workspace.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description:
        "Removal blocked — `last_owner_protected` when the target is the only live owner; `conflict` when a PG serializable race loses at commit (same invariant family, transient).",
      content: {
        "application/json": {
          schema: z.object({
            error: z.union([z.literal("last_owner_protected"), z.literal("conflict")]),
          }),
        },
      },
    },
  },
});

export const memberRemove = defineOpenAPIRoute<typeof memberRemoveRouteDef, ApiEnv, true>({
  route: memberRemoveRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const body = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: WORKSPACE_MEMBER_REMOVE_ID,
      input: body,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof RemoveResponse>, 200);
  },
  addRoute: true,
});
