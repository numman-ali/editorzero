/**
 * `POST /collections/update` — collection.update surface (invariant 4).
 *
 * Metadata-only mutation. Renames a collection; slug is derived from
 * title via `slugify` (same derivation as `collection.create` /
 * `doc.rename`).
 *
 * **Status — 200 OK** (not 201; this is an update, not a create).
 *
 * **409 response** — `SlugCollisionError` (sibling-slug collision,
 * `code: "slug_collision"`). The global error mapper serializes
 * `err.code` directly — same shape `doc.update`'s 409 uses with
 * `stale_precondition` / `conflict`. The 409 body is `{ error:
 * "slug_collision" }` so callers can differentiate retry copy.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const COLLECTION_UPDATE_ID = CapabilityId("collection.update");

const UpdateParams = z
  .object({ collection_id: z.string().uuid() })
  .openapi("CollectionUpdateParams");

const UpdateRequest = z
  .object({
    title: z.string().trim().min(1, "title must not be empty or whitespace-only"),
  })
  .strict()
  .openapi("CollectionUpdateRequest");

const UpdateResponse = z
  .object({
    collection_id: z.string(),
    title: z.string(),
    slug: z.string(),
    updated_at: z.number(),
  })
  .openapi("CollectionUpdateResponse");

const updateRouteDef = createRoute({
  method: "post",
  path: "/collections/update/{collection_id}",
  tags: ["collections"],
  summary: "Rename a collection (title → slug derivation). Metadata-only.",
  request: {
    params: UpdateParams,
    body: {
      content: { "application/json": { schema: UpdateRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Updated — post-rename metadata.",
      content: { "application/json": { schema: UpdateResponse } },
    },
    400: {
      description: "Validation error (empty/whitespace-only title).",
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
      description: "Permission denied — caller lacks `doc:write`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
    404: {
      description: "The collection does not exist or is soft-deleted.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description: "Sibling-slug collision — derived slug is already taken by a live sibling.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("slug_collision") }),
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
    const { collection_id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: COLLECTION_UPDATE_ID,
      input: { collection_id, ...body },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof UpdateResponse>, 200);
  },
  addRoute: true,
});
