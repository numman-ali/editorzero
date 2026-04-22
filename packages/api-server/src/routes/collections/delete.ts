/**
 * `POST /collections/delete` — collection.delete surface (invariant 4).
 *
 * Metadata-only mutation. Soft-deletes a collection; refuses (409) if
 * live descendants (child collections or docs) remain.
 *
 * **Status — 200 OK** (same as `doc.delete` — soft-delete returns the
 * post-state metadata, not a create).
 *
 * **409 response** — `HasLiveDescendantsError` (`code:
 * "has_live_descendants"`) when the target still has live direct
 * children. The global error mapper serializes `err.code` directly,
 * so the body is `{ error: "has_live_descendants" }`.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const COLLECTION_DELETE_ID = CapabilityId("collection.delete");

const DeleteParams = z
  .object({ collection_id: z.string().uuid() })
  .openapi("CollectionDeleteParams");

const DeleteResponse = z
  .object({
    collection_id: z.string(),
    deleted_at: z.number(),
  })
  .openapi("CollectionDeleteResponse");

const deleteRouteDef = createRoute({
  method: "post",
  path: "/collections/delete/{collection_id}",
  tags: ["collections"],
  summary: "Soft-delete a collection; refuses if live descendants remain.",
  request: {
    params: DeleteParams,
  },
  responses: {
    200: {
      description: "Soft-deleted — echoes id + deleted_at anchor.",
      content: { "application/json": { schema: DeleteResponse } },
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
      description: "The collection does not exist or is already soft-deleted.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description:
        "Live descendants exist (child collections or docs); empty the collection first.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("has_live_descendants") }),
        },
      },
    },
  },
});

export const del = defineOpenAPIRoute<typeof deleteRouteDef, ApiEnv, true>({
  route: deleteRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const { collection_id } = c.req.valid("param");
    const result = await dispatcher.dispatch({
      capability_id: COLLECTION_DELETE_ID,
      input: { collection_id },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof DeleteResponse>, 200);
  },
  addRoute: true,
});
