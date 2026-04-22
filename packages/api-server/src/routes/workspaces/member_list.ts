/**
 * `GET /workspaces/member_list` — workspace.member_list surface
 * (invariant 4).
 *
 * Query-string schema. `limit`, `before_created_at`, `before_user_id`,
 * and `role` live on the URL; `z.coerce.*` parses numeric values at the
 * route boundary so the dispatcher's zod parse sees the shape the
 * capability declares.
 *
 * **Cursor shape.** `(before_created_at, before_user_id)` surfaced as
 * two explicit query keys rather than an opaque blob — the CLI renders
 * the next-page args at a glance (`ez workspaces member-list
 * --before-created-at=<n> --before-user-id=<uuid>`). The both-or-
 * neither refine mirrors the capability so the OpenAPI / generated-
 * client contract matches runtime. Same class of drift Codex flagged
 * on `doc.update`.
 *
 * **Scope.** `workspace:admin` — the capability refuses other callers
 * at the dispatcher gate. The route declares 403 so the OpenAPI doc
 * carries the contract.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { ROLES } from "@editorzero/scopes";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const WORKSPACE_MEMBER_LIST_ID = CapabilityId("workspace.member_list");

const MemberListQuery = z
  .object({
    // All query-string values arrive as strings; `z.coerce.*` parses
    // at the route boundary so the dispatcher's zod parse sees the
    // numeric/enum shape the capability declares.
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before_created_at: z.coerce.number().int().optional(),
    before_user_id: z.string().optional(),
    role: z.enum(ROLES).optional(),
  })
  .refine(
    (v) =>
      (v.before_created_at === undefined && v.before_user_id === undefined) ||
      (v.before_created_at !== undefined && v.before_user_id !== undefined),
    { message: "before_created_at and before_user_id must be provided together" },
  )
  .openapi("WorkspaceMemberListQuery");

const MemberRow = z
  .object({
    user_id: z.string(),
    role: z.enum(ROLES),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .openapi("WorkspaceMemberRow");

const MemberCursor = z
  .object({
    before_created_at: z.number(),
    before_user_id: z.string(),
  })
  .openapi("WorkspaceMemberCursor");

const MemberListResponse = z
  .object({
    members: z.array(MemberRow),
    next_cursor: MemberCursor.nullable(),
  })
  .openapi("WorkspaceMemberListResponse");

const memberListRouteDef = createRoute({
  method: "get",
  path: "/workspaces/member_list",
  tags: ["workspaces"],
  summary: "List active workspace members; paginated, admin-only.",
  request: {
    query: MemberListQuery,
  },
  responses: {
    200: {
      description: "Page of members with an optional next-page cursor.",
      content: { "application/json": { schema: MemberListResponse } },
    },
    400: {
      description: "Validation error — mismatched cursor pair or invalid role filter.",
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
  },
});

export const memberList = defineOpenAPIRoute<typeof memberListRouteDef, ApiEnv, true>({
  route: memberListRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const query = c.req.valid("query");
    const result = await dispatcher.dispatch({
      capability_id: WORKSPACE_MEMBER_LIST_ID,
      input: query,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof MemberListResponse>, 200);
  },
  addRoute: true,
});
