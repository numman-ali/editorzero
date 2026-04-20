/**
 * `POST /docs/restore/:doc_id` — revive a soft-deleted doc.
 *
 * Inverse of `POST /docs/delete/:doc_id`; same metadata-only lane.
 * Flips `docs.deleted_at` from non-NULL back to NULL + bumps
 * `visibility_version`. See `routes/docs/delete.ts` for the fuller
 * route-posture discussion; this doc-block keeps only the deltas.
 *
 * **Status codes.**
 *   200 — restored: `deleted_at` cleared, `visibility_version` bumped.
 *         Body carries `{ doc_id, visibility_version }`. No
 *         `restored_at` field (audit envelope owns event time; see
 *         capability doc-block).
 *   400 — malformed doc_id.
 *   401 — unauthenticated.
 *   403 — permission denied; caller lacks `doc:delete` (same scope
 *         as delete — symmetric rollback rights).
 *   404 — doc missing OR already live (not-trashed). Restore on an
 *         already-live doc is 404 to avoid no-op audit rows.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const DOC_RESTORE_ID = CapabilityId("doc.restore");

const RestoreParams = z
  .object({
    doc_id: z.uuid({ version: "v7", message: "doc_id must be a UUIDv7" }),
  })
  .openapi("DocRestoreParams");

const RestoreResponse = z
  .object({
    doc_id: z.string(),
    visibility_version: z.number(),
  })
  .openapi("DocRestoreResponse");

const restoreRouteDef = createRoute({
  method: "post",
  path: "/docs/restore/:doc_id",
  tags: ["docs"],
  summary: "Restore a soft-deleted doc (inverse of doc.delete).",
  request: {
    params: RestoreParams,
  },
  responses: {
    200: {
      description: "Doc restored; deleted_at cleared, visibility_version bumped.",
      content: { "application/json": { schema: RestoreResponse } },
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
      description: "Doc not found, or already live (not soft-deleted).",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
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
    const { doc_id } = c.req.valid("param");
    const result = await dispatcher.dispatch({
      capability_id: DOC_RESTORE_ID,
      input: { doc_id },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof RestoreResponse>, 200);
  },
  addRoute: true,
});
