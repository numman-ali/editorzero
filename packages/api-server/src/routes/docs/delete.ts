/**
 * `POST /docs/delete/:doc_id` — soft-delete a doc.
 *
 * Metadata-only mutation route; same three-part shape as publish /
 * unpublish. Mutates `docs.deleted_at` + bumps `visibility_version`
 * in the dispatcher's write-path tx; no Y.Doc touching, no
 * `doc_updates` row.
 *
 * **Why POST.** Capability changes server state (no GET). Path is
 * capability-shaped (`/docs/delete/:id`) rather than subresource-
 * shaped (`DELETE /docs/:id`) — matches the convention the rest of
 * the `docs/*` slice uses. HTTP `DELETE` verb would also be
 * semantically acceptable but would split the verb conventions across
 * the domain for no clear reader benefit.
 *
 * **No request body.** Only input is the path-param `doc_id`.
 *
 * **Status codes.**
 *   200 — soft-deleted: `deleted_at` set, `visibility_version`
 *         bumped. Body carries `{ doc_id, deleted_at, visibility_version }`.
 *   400 — malformed doc_id (not a v7 UUID).
 *   401 — unauthenticated.
 *   403 — permission denied; caller lacks `doc:delete`.
 *   404 — doc missing OR already soft-deleted. Re-delete is an
 *         honest 404 because the recovery-window anchor would slide
 *         otherwise (see capability doc-block).
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const DOC_DELETE_ID = CapabilityId("doc.delete");

// Path parameter schema — 400s on non-UUIDv7 strings. Same shape as
// publish/unpublish/get; the capability's InputSchema re-validates and
// applies the `DocId` brand at the dispatcher boundary.
const DeleteParams = z
  .object({
    doc_id: z.uuid({ version: "v7", message: "doc_id must be a UUIDv7" }),
  })
  .openapi("DocDeleteParams");

// Response schema — mirrors `doc.delete`'s OutputSchema. Branded IDs
// serialise as plain strings.
const DeleteResponse = z
  .object({
    doc_id: z.string(),
    deleted_at: z.number(),
    visibility_version: z.number(),
  })
  .openapi("DocDeleteResponse");

const deleteRouteDef = createRoute({
  method: "post",
  path: "/docs/delete/:doc_id",
  tags: ["docs"],
  summary: "Soft-delete a doc.",
  request: {
    params: DeleteParams,
  },
  responses: {
    200: {
      description:
        "Doc soft-deleted; deleted_at anchors the recovery window, visibility_version bumped.",
      content: { "application/json": { schema: DeleteResponse } },
    },
    400: {
      description: "Validation error (malformed doc_id).",
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
      description: "Permission denied — caller lacks `doc:delete`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
    404: {
      description: "Doc not found, or already soft-deleted.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
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
    const { doc_id } = c.req.valid("param");
    const result = await dispatcher.dispatch({
      capability_id: DOC_DELETE_ID,
      input: { doc_id },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof DeleteResponse>, 200);
  },
  addRoute: true,
});
