/**
 * `POST /workspaces/update` — workspace.update surface (invariant 4).
 *
 * Metadata-only mutation. Updates `name`, `trash_retention_days`, or
 * `settings` (any subset — at least one required). Scope
 * `workspace:admin`; members / guests get 403.
 *
 * Path follows the repo-wide `<plural>/<action>` convention (see
 * `workspace.get` route header and `apps/cli/src/generator/http-
 * binding.ts`); the parity test ensures the derived binding matches.
 *
 * **Status — 200 OK** (update, not create). Echoes the post-state of
 * the mutable fields plus `workspace_id` so callers don't need a
 * follow-up `GET /workspaces/get`.
 *
 * **No slug.** `slug` is derived at bootstrap and is not part of this
 * surface (see `workspace.update` capability header). A request body
 * with `{ slug: ... }` is rejected by the strict schema as a 400.
 *
 * **No-op rejection.** The underlying capability refuses an empty
 * `{}` input at the zod boundary — surfaces here as 400.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const WORKSPACE_UPDATE_ID = CapabilityId("workspace.update");

// At-least-one-field refine mirrors the capability's input boundary so
// the OpenAPI / `hc<AppType>` contract matches runtime behaviour. Without
// it, generated clients would treat `{}` as valid while the capability
// would throw at zod parse — the exact kind of route/capability drift
// Codex flagged on `doc.update`'s follow-on fix.
const UpdateRequest = z
  .object({
    name: z.string().trim().min(1, "name must not be empty or whitespace-only").optional(),
    trash_retention_days: z
      .number()
      .int("trash_retention_days must be an integer")
      .min(7, "trash_retention_days must be at least 7")
      .max(365, "trash_retention_days must be at most 365")
      .optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.trash_retention_days !== undefined || v.settings !== undefined,
    { message: "at least one of name, trash_retention_days, settings must be provided" },
  )
  .openapi("WorkspaceUpdateRequest");

const UpdateResponse = z
  .object({
    workspace_id: z.string(),
    name: z.string(),
    trash_retention_days: z.number(),
    settings: z.record(z.string(), z.unknown()),
  })
  .openapi("WorkspaceUpdateResponse");

const updateRouteDef = createRoute({
  method: "post",
  path: "/workspaces/update",
  tags: ["workspaces"],
  summary: "Update the caller's workspace (name, trash_retention_days, settings).",
  request: {
    body: {
      content: { "application/json": { schema: UpdateRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Updated — post-patch metadata.",
      content: { "application/json": { schema: UpdateResponse } },
    },
    400: {
      description:
        "Validation error — empty patch, invalid retention bound, or unknown body key (e.g. slug).",
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
      description: "Workspace is soft-deleted or missing (bootstrap gap).",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
  },
});

export const update = defineOpenAPIRoute<typeof updateRouteDef, ApiEnv, true>({
  route: updateRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const body = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: WORKSPACE_UPDATE_ID,
      input: body,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof UpdateResponse>, 200);
  },
  addRoute: true,
});
