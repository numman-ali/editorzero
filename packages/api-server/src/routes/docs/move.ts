/**
 * `POST /docs/move/:doc_id` — doc.move surface (invariant 4).
 *
 * Metadata-only mutation. Re-parents a doc under a different collection
 * (or the workspace root via `new_collection_id: null`). Docs are tree
 * leaves, so the shape is strictly simpler than `collection.move` — no
 * cycle walk, no subtree-height check. Target existence + target-scope
 * slug uniqueness are the two preconditions.
 *
 * **Status — 200 OK**.
 *
 * **400** — malformed body (`new_collection_id` not UUIDv7 or missing).
 *
 * **404** — doc missing/soft-deleted, or target collection
 * missing/soft-deleted (cross-workspace targets surface as 404 via the
 * tenant scoping plugin; no existence leakage across boundaries).
 *
 * **409** — `SlugCollisionError` when the moved doc's slug clashes with
 * a live sibling doc in the target scope (root: `collection_id IS NULL`;
 * nested: same `collection_id`). Body: `{ error: "slug_collision" }`.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const DOC_MOVE_ID = CapabilityId("doc.move");

const MoveParams = z
  .object({
    doc_id: z.uuid({ version: "v7", message: "doc_id must be a UUIDv7" }),
  })
  .openapi("DocMoveParams");

const MoveRequest = z
  .object({
    new_collection_id: z.string().uuid().nullable(),
  })
  .strict()
  .openapi("DocMoveRequest");

const MoveResponse = z
  .object({
    doc_id: z.string(),
    new_collection_id: z.string().nullable(),
    new_order_key: z.string(),
    updated_at: z.number(),
  })
  .openapi("DocMoveResponse");

const moveRouteDef = createRoute({
  method: "post",
  path: "/docs/move/{doc_id}",
  tags: ["docs"],
  summary: "Re-parent a doc under a different collection (or to the workspace root).",
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
      description: "Validation error (malformed body).",
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
      description: "Doc or target collection does not exist or is soft-deleted.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
    409: {
      description:
        "Sibling-slug collision — moved doc's slug is already taken by a live sibling in the target collection scope.",
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
    const { doc_id } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: DOC_MOVE_ID,
      input: { doc_id, ...body },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof MoveResponse>, 200);
  },
  addRoute: true,
});
