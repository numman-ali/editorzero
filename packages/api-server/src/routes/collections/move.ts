/**
 * `POST /collections/move/:collection_id` — collection.move surface
 * (invariant 4).
 *
 * Metadata-only mutation. Re-parents a collection within the workspace
 * under a different parent (or the workspace root via
 * `new_parent_id: null`).
 *
 * **Status — 200 OK**.
 *
 * **400 responses** — `ValidationError` for (a) cycle detection
 * (issue code `cycle_detected`), (b) depth-cap exceeded (issue code
 * `depth_cap_exceeded`). Both surface with `err.code === "validation"`
 * through the global mapper; the structured issue list carries the
 * specific failure code. Same shape slice-1 `collection.create` uses
 * for its own `depth_cap_exceeded` case.
 *
 * **409 response** — `SlugCollisionError` when the moved collection's
 * slug clashes with a live sibling under the target parent.
 * `code: "slug_collision"`. Race window (pre-check → UPDATE) remains
 * guarded by the partial unique index.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const COLLECTION_MOVE_ID = CapabilityId("collection.move");

const MoveParams = z.object({ collection_id: z.string().uuid() }).openapi("CollectionMoveParams");

const MoveRequest = z
  .object({
    new_parent_id: z.string().uuid().nullable(),
  })
  .strict()
  .openapi("CollectionMoveRequest");

const MoveResponse = z
  .object({
    collection_id: z.string(),
    new_parent_id: z.string().nullable(),
    new_order_key: z.string(),
    updated_at: z.number(),
  })
  .openapi("CollectionMoveResponse");

const moveRouteDef = createRoute({
  method: "post",
  path: "/collections/move/{collection_id}",
  tags: ["collections"],
  summary:
    "Re-parent a collection. Refuses cycles, preserves the depth cap, enforces target-scope slug uniqueness.",
  request: {
    params: MoveParams,
    body: {
      content: { "application/json": { schema: MoveRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Moved — post-move metadata.",
      content: { "application/json": { schema: MoveResponse } },
    },
    400: {
      description: "Validation error (cycle, depth-cap exceeded, or malformed body).",
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
      description: "The moved collection or the target parent does not exist or is soft-deleted.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description:
        "Sibling-slug collision — moved collection's slug is already taken by a live sibling under the target parent.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("slug_collision") }),
        },
      },
    },
  },
});

export const move = defineOpenAPIRoute<typeof moveRouteDef, ApiEnv, true>({
  route: moveRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const { collection_id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: COLLECTION_MOVE_ID,
      input: { collection_id, ...body },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof MoveResponse>, 200);
  },
  addRoute: true,
});
