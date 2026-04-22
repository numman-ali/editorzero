/**
 * `GET /collections/list` — collection.list surface (ADR 0021 / invariant 4).
 *
 * Sibling of `/docs/list`. Same three-part shape:
 *
 *   1. zod schemas for input/output pinned on the route so OpenAPI +
 *      `hc<AppType>` RPC stay owned here (not coupled to the
 *      capability's branded-transform output schema).
 *   2. Handler reads `c.var.principal` + `c.var.dispatcher` (attached
 *      by the trunk's `/collections/*` middleware chain — see `app.ts`
 *      where `createApiApp` mounts `createPrincipalMiddleware` +
 *      `createDispatcherMiddleware` on this prefix alongside `/docs/*`).
 *   3. Capability output returns as-is via `c.json` at status 200.
 *
 * **Audit + permission gate live inside the dispatcher**, not here.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const COLLECTION_LIST_ID = CapabilityId("collection.list");

const CollectionSummary = z
  .object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
    parent_id: z.string().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .openapi("CollectionSummary");

const CollectionListResponse = z
  .object({
    collections: z.array(CollectionSummary),
  })
  .openapi("CollectionListResponse");

const listRoute = createRoute({
  method: "get",
  path: "/collections/list",
  tags: ["collections"],
  summary: "List all non-deleted collections in the caller's workspace.",
  responses: {
    200: {
      description: "Collections list.",
      content: { "application/json": { schema: CollectionListResponse } },
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
      description: "Permission denied.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
  },
});

export const list = defineOpenAPIRoute<typeof listRoute, ApiEnv, true>({
  route: listRoute,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const result = await dispatcher.dispatch({
      capability_id: COLLECTION_LIST_ID,
      input: {},
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof CollectionListResponse>, 200);
  },
  addRoute: true,
});
