/**
 * `POST /docs/rename/:doc_id` — rename a doc.
 *
 * Second content-mutation route (after `doc.create`). The capability
 * threads through `ctx.transact` to mutate the Y.Doc's title block;
 * the route itself stays a thin dispatcher-call, same shape as every
 * other `docs/*` route.
 *
 * **Why POST `/docs/rename/:doc_id` + body.** The path targets the
 * doc being renamed via a capability-style prefix (matches `publish`,
 * `unpublish`, `delete`, `restore`); the new title travels in the
 * body. A PUT on a notional `/docs/:doc_id/title` subresource would
 * also fit semantically, but the repo's convention is capability-style
 * paths — staying on that keeps route discovery a function of the
 * capability id, not REST resource modelling.
 *
 * **Status codes.**
 *   200 — renamed; body carries the post-rename projection
 *         `{ doc_id, title, slug, updated_at }`. No 201 — rename
 *         mutates an existing doc, doesn't create.
 *   400 — malformed `doc_id` (not v7 UUID) or empty/whitespace-only
 *         title.
 *   401 — unauthenticated (principal middleware rejected before
 *         handler).
 *   403 — permission denied; caller lacks `doc:write`.
 *   404 — doc missing or soft-deleted (rename is a live-doc op, not
 *         resurrection — callers use `doc.restore` first).
 *
 * **Audit + write-path tx live inside the dispatcher.** The dispatcher
 * opens one `BEGIN IMMEDIATE`, runs the handler (which UPDATEs
 * `docs.title/slug/updated_at` then threads through `ctx.transact` to
 * rewrite the Y.Doc's heading-1 block), emits one
 * `outbox(doc.updated)` via the bound sync writer + the audit row in
 * the same tx, and commits atomically. Route-side is thin.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const DOC_RENAME_ID = CapabilityId("doc.rename");

// Path parameter schema — mirrors `doc/publish`'s shape. `DocId()`
// brand applies at the dispatcher boundary (the capability's input
// schema re-validates with the branded transform).
const RenameParams = z
  .object({
    doc_id: z.uuid({ version: "v7", message: "doc_id must be a UUIDv7" }),
  })
  .openapi("DocRenameParams");

// Body schema — `{ title }` with the same `.trim().min(1)` posture as
// `doc.create`'s request body. Duplicated here (not imported from the
// capability's InputSchema) so the OpenAPI contract + `hc<AppType>`
// RPC types are owned by the route, matching the pattern `doc/create`
// establishes.
const RenameRequest = z
  .object({
    title: z.string().trim().min(1, "title must not be empty or whitespace-only"),
  })
  .strict()
  .openapi("DocRenameRequest");

// Response shape — plain strings on the wire; the capability's
// branded IDs serialise identically.
const RenameResponse = z
  .object({
    doc_id: z.string(),
    title: z.string(),
    slug: z.string(),
    updated_at: z.number(),
  })
  .openapi("DocRenameResponse");

const renameRouteDef = createRoute({
  method: "post",
  path: "/docs/rename/:doc_id",
  tags: ["docs"],
  summary: "Rename a doc — updates the title-block heading + the docs.title bridge.",
  request: {
    params: RenameParams,
    body: {
      content: { "application/json": { schema: RenameRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Renamed — post-state projection.",
      content: { "application/json": { schema: RenameResponse } },
    },
    400: {
      description: "Validation error (malformed doc_id or empty/whitespace-only title).",
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
      description: "Doc not found (or soft-deleted).",
      content: {
        "application/json": {
          schema: z.object({ error: z.literal("not_found") }),
        },
      },
    },
  },
});

export const rename = defineOpenAPIRoute<typeof renameRouteDef, ApiEnv, true>({
  route: renameRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const { doc_id } = c.req.valid("param");
    const { title } = c.req.valid("json");
    const result = await dispatcher.dispatch({
      capability_id: DOC_RENAME_ID,
      input: { doc_id, title },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof RenameResponse>, 200);
  },
  addRoute: true,
});
