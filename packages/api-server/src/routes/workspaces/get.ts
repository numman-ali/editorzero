/**
 * `GET /workspaces/get` — workspace.get surface (invariant 4).
 *
 * Returns the caller's workspace metadata (slug, name, retention,
 * settings). The principal already carries `workspace_id`; no path
 * param is required. The `/get` suffix matches the repo-wide
 * `<plural>/<action>` convention (F87 — `apps/cli` derives HTTP
 * bindings from the capability id via this rule; parity test
 * `apps/cli/src/generator/parity.unit.test.ts` asserts the CLI's
 * derived binding matches a registered route). Today's convention
 * outranks readability; future multi-workspace capabilities will
 * take `workspace_id` as a path param (`/workspaces/get/:workspace_id`)
 * naturally under the same rule.
 *
 * Same three-part shape as the `/collections/list` sibling:
 *
 *   1. zod schemas pinned on the route for OpenAPI + `hc<AppType>`.
 *   2. Handler reads `c.var.principal` + `c.var.dispatcher` from the
 *      `/workspaces/*` middleware chain (see `app.ts`).
 *   3. Capability output returns as-is at 200.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const WORKSPACE_GET_ID = CapabilityId("workspace.get");

const WorkspaceResponse = z
  .object({
    workspace_id: z.string(),
    slug: z.string(),
    name: z.string(),
    trash_retention_days: z.number(),
    created_by: z.string(),
    created_at: z.number(),
    // `settings` is a free-form key/unknown map on this surface — a
    // settings-shape schema will live in a settings-aware route when
    // that capability lands.
    settings: z.record(z.string(), z.unknown()),
  })
  .openapi("WorkspaceResponse");

const getRouteDef = createRoute({
  method: "get",
  path: "/workspaces/get",
  tags: ["workspaces"],
  summary: "Read the caller's workspace metadata.",
  responses: {
    200: {
      description: "The caller's workspace.",
      content: { "application/json": { schema: WorkspaceResponse } },
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
      description: "Permission denied — caller lacks `workspace:read`.",
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

export const get = defineOpenAPIRoute<typeof getRouteDef, ApiEnv, true>({
  route: getRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const result = await dispatcher.dispatch({
      capability_id: WORKSPACE_GET_ID,
      input: {},
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof WorkspaceResponse>, 200);
  },
  addRoute: true,
});
