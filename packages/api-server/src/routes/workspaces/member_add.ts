/**
 * `POST /workspaces/member_add` — workspace.member_add surface
 * (invariant 4).
 *
 * Metadata-only mutation. Adds or revives-in-place a workspace
 * membership row; scope `workspace:admin`. Body carries `{user_id,
 * role}` — not a path param because the domain's `<domain>_id`
 * convention belongs to `workspace_id`, and this capability targets
 * the ambient workspace (pinned via principal). The
 * `deriveHttpBinding` rule (`apps/cli/src/generator/http-binding.ts`)
 * produces the same shape.
 *
 * **Status — 200 OK** (add-or-revive, not create — the API-level
 * distinction between fresh-INSERT and soft-deleted-revive is hidden
 * from the surface; both are "member now exists with role X"). Echoes
 * `{workspace_id, user_id, role, created_at, updated_at}` so callers
 * distinguishing the two branches can read `created_at` (preserved on
 * revive) vs `updated_at` (always bumped).
 *
 * **409 Conflict — `member_already_exists`.** The target already has
 * a live membership row; the caller's view of the roster is stale.
 * Role changes on an existing member flow through
 * `workspace.member_update_role`. `conflict` surfaces for the PG
 * serializable race where two concurrent revives both pass their
 * in-tx pre-check and one aborts at commit.
 *
 * **No 404 branch in slice 1.** An input `user_id` referencing a
 * non-existent BA `user` row surfaces as an untyped error (see
 * capability doc-block — pre-check deferred to the user-resolution
 * slice).
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { ROLES } from "@editorzero/scopes";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const WORKSPACE_MEMBER_ADD_ID = CapabilityId("workspace.member_add");

const AddRequest = z
  .object({
    user_id: z.string().min(1, "user_id must not be empty"),
    role: z.enum(ROLES),
  })
  .strict()
  .openapi("WorkspaceMemberAddRequest");

const AddResponse = z
  .object({
    workspace_id: z.string(),
    user_id: z.string(),
    role: z.enum(ROLES),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .openapi("WorkspaceMemberAddResponse");

const memberAddRouteDef = createRoute({
  method: "post",
  path: "/workspaces/member_add",
  tags: ["workspaces"],
  summary: "Add or revive a workspace member; metadata-only, admin-only.",
  request: {
    body: {
      content: { "application/json": { schema: AddRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "Member added or revived-in-place. `created_at` preserved across revive (ADR 0024 §5); `updated_at` always bumped.",
      content: { "application/json": { schema: AddResponse } },
    },
    400: {
      description: "Validation error — missing user_id, unknown role, or unknown body key.",
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
    409: {
      description:
        "Add blocked — `member_already_exists` when the target has a live membership row; `conflict` when a PG serializable race loses at commit (same invariant family, transient).",
      content: {
        "application/json": {
          schema: z.object({
            error: z.union([z.literal("member_already_exists"), z.literal("conflict")]),
          }),
        },
      },
    },
  },
});

export const memberAdd = defineOpenAPIRoute<typeof memberAddRouteDef, ApiEnv, true>({
  route: memberAddRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const body = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: WORKSPACE_MEMBER_ADD_ID,
      input: body,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof AddResponse>, 200);
  },
  addRoute: true,
});
