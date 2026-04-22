/**
 * `POST /collections/restore` — collection.restore surface (invariant 4).
 *
 * Metadata-only mutation. Revives a soft-deleted collection; refuses
 * (409) if the parent collection is itself soft-deleted (would create
 * an inconsistent tree — see `collection.restore` header).
 *
 * **Status — 200 OK**.
 *
 * **409 response** — `ParentDeletedError` (`code: "parent_deleted"`)
 * when the parent collection is soft-deleted or missing. The global
 * error mapper serializes `err.code` directly, so the body is
 * `{ error: "parent_deleted" }`.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const COLLECTION_RESTORE_ID = CapabilityId("collection.restore");

const RestoreParams = z
  .object({ collection_id: z.string().uuid() })
  .openapi("CollectionRestoreParams");

const RestoreResponse = z
  .object({
    collection_id: z.string(),
  })
  .openapi("CollectionRestoreResponse");

const restoreRouteDef = createRoute({
  method: "post",
  path: "/collections/restore/{collection_id}",
  tags: ["collections"],
  summary: "Restore a soft-deleted collection; refuses if the parent is soft-deleted.",
  request: {
    params: RestoreParams,
  },
  responses: {
    200: {
      description: "Restored — echoes id.",
      content: { "application/json": { schema: RestoreResponse } },
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
      description: "Permission denied — caller lacks `doc:delete`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
    404: {
      description: "The collection does not exist or is already live.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description: "Parent collection is soft-deleted or missing; restore it first.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("parent_deleted") }),
        },
      },
    },
  },
});

export const restore = defineOpenAPIRoute<typeof restoreRouteDef, ApiEnv, true>({
  route: restoreRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const { collection_id } = c.req.valid("param");
    const result = await dispatcher.dispatch({
      capability_id: COLLECTION_RESTORE_ID,
      input: { collection_id },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof RestoreResponse>, 200);
  },
  addRoute: true,
});
