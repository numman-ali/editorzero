/**
 * `POST /docs/unpublish/:doc_id` — set a doc's visibility back to
 * `"workspace"` (inverse of `doc.publish`).
 *
 * Fifth capability route; second metadata-only mutation. Same three-part
 * route shape as `publish.ts` — only the capability id, response-state
 * literal, and missing `published_at` differ. See `publish.ts` for the
 * fuller discussion of the metadata-only lane; this doc-block keeps
 * only the deltas.
 *
 * **Why POST, no body.** Same reasoning as publish: capability changes
 * server state (no GET), path is capability-shaped rather than
 * subresource-shaped (no PUT on `/docs/<id>/visibility`), input is
 * only the path-param `doc_id` (no body).
 *
 * **Status codes.**
 *   200 — flipped (or re-asserted) to `visibility="workspace"`;
 *         `visibility_version` bumped by 1. Body carries the post-state
 *         projection. Intentionally no `unpublished_at` — the target
 *         DDL has no symmetric column for the un-publish side (see
 *         `capabilities/src/doc/unpublish.ts` audit-effect rationale).
 *   400 — malformed doc_id (not a v7 UUID).
 *   401 — unauthenticated (middleware-rejected before handler).
 *   403 — permission denied; caller lacks `doc:publish` (same scope as
 *         publish — admins retain rollback).
 *   404 — doc missing or soft-deleted (unpublishing a trashed doc has
 *         no defined meaning; see capability doc-block).
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const DOC_UNPUBLISH_ID = CapabilityId("doc.unpublish");

// Path parameter schema — mirrors `publish.ts`'s param schema; same
// v7-only constraint, the capability re-validates + brands at the
// dispatcher boundary.
const UnpublishParams = z
  .object({
    doc_id: z.uuid({ version: "v7", message: "doc_id must be a UUIDv7" }),
  })
  .openapi("DocUnpublishParams");

// Response schema — mirrors `doc.unpublish`'s OutputSchema. Branded IDs
// serialise as plain strings. `visibility` is a literal `"workspace"`.
// No `published_at`: architecture.md target DDL has no `unpublished_at`
// (see capability doc-block).
const UnpublishResponse = z
  .object({
    doc_id: z.string(),
    visibility: z.literal("workspace"),
    visibility_version: z.number(),
  })
  .openapi("DocUnpublishResponse");

const unpublishRouteDef = createRoute({
  method: "post",
  path: "/docs/unpublish/:doc_id",
  tags: ["docs"],
  summary: "Set a doc's visibility back to workspace (inverse of doc.publish).",
  request: {
    params: UnpublishParams,
  },
  responses: {
    200: {
      description:
        "Doc visibility flipped (or re-asserted) to workspace; visibility_version bumped.",
      content: { "application/json": { schema: UnpublishResponse } },
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
      description: "Permission denied — caller lacks `doc:publish`.",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("permission_denied") }),
        },
      },
    },
    404: {
      description: "Doc not found (or soft-deleted).",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
  },
});

export const unpublish = defineOpenAPIRoute<typeof unpublishRouteDef, ApiEnv, true>({
  route: unpublishRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const { doc_id } = c.req.valid("param");
    const result = await dispatcher.dispatch({
      capability_id: DOC_UNPUBLISH_ID,
      input: { doc_id },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof UnpublishResponse>, 200);
  },
  addRoute: true,
});
