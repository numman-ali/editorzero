/**
 * `POST /docs/publish/:doc_id` — flip a doc's visibility to public.
 *
 * Fourth capability route (after `doc.list`, `doc.create`, `doc.get`);
 * first metadata-only mutation route. Mutates the `docs` row in the
 * dispatcher's write-path tx without touching the Y.Doc — `ctx.transact`
 * is never called, so no `doc_updates` row is produced. Follows the
 * same three-part route shape as the rest of the `docs/*` slice.
 *
 * **Why POST.** The capability changes server state, which rules out
 * GET. PUT would also fit ("replace the visibility state") but the
 * path doesn't target a single-field subresource (`/docs/<id>/visibility`);
 * POST on a capability-style path is the convention the slice started
 * with (`POST /docs/create`). Future visibility-widening capabilities
 * (e.g. `doc.unpublish`, a future `doc.set_visibility`) ride the same
 * verb on their own capability paths.
 *
 * **No request body.** The capability's only input is the path-param
 * `doc_id`; there's nothing to put in the body. An empty POST with
 * `Content-Length: 0` is the expected shape. A future
 * `doc.set_visibility` that widens to arbitrary visibility states
 * would move the target state into the body.
 *
 * **Status codes.**
 *   200 — flipped (or re-asserted): `visibility="public"`,
 *         `visibility_version` bumped by 1. Body carries the
 *         post-state projection.
 *   400 — malformed doc_id (not a v7 UUID).
 *   401 — unauthenticated (middleware-rejected before handler).
 *   403 — permission denied; caller lacks `doc:publish`.
 *   404 — doc missing or soft-deleted (publish is visibility, not
 *         resurrection — callers with `doc:delete` use `doc.restore`
 *         first).
 *
 * **Audit + write-path tx live inside the dispatcher.** The dispatcher
 * opens one `BEGIN IMMEDIATE`, runs the handler's SELECT+UPDATE against
 * `ctx.db`, writes `audit_events(allow)` + `outbox(audit.appended)` in
 * the same tx, and commits atomically. The route handler itself only
 * dispatches.
 */

import { CapabilityId } from "@editorzero/ids";
import type { UserPrincipal } from "@editorzero/principal";
import { createRoute, defineOpenAPIRoute, z } from "@hono/zod-openapi";

import type { ApiEnv } from "../../env";

const DOC_PUBLISH_ID = CapabilityId("doc.publish");

// Path parameter schema — 400s on non-UUIDv7 strings. Same shape as
// `doc/get`'s path schema; the capability's InputSchema re-validates
// and applies the `DocId` brand at the dispatcher boundary.
const PublishParams = z
  .object({
    doc_id: z.uuid({ version: "v7", message: "doc_id must be a UUIDv7" }),
  })
  .openapi("DocPublishParams");

// Response schema — mirrors `doc.publish`'s OutputSchema at wire level.
// Branded IDs serialise as plain strings. `visibility` is a literal
// `"public"` because the capability only lands on that state.
const PublishResponse = z
  .object({
    doc_id: z.string(),
    visibility: z.literal("public"),
    visibility_version: z.number(),
    published_at: z.number(),
  })
  .openapi("DocPublishResponse");

const publishRouteDef = createRoute({
  method: "post",
  path: "/docs/publish/:doc_id",
  tags: ["docs"],
  summary: "Set a doc's visibility to public.",
  request: {
    params: PublishParams,
  },
  responses: {
    200: {
      description: "Doc visibility flipped (or re-asserted) to public; visibility_version bumped.",
      content: { "application/json": { schema: PublishResponse } },
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

export const publish = defineOpenAPIRoute<typeof publishRouteDef, ApiEnv, true>({
  route: publishRouteDef,
  handler: async (c) => {
    const principal = c.var.principal as UserPrincipal;
    const dispatcher = c.var.dispatcher;
    const { doc_id } = c.req.valid("param");
    const result = await dispatcher.dispatch({
      capability_id: DOC_PUBLISH_ID,
      input: { doc_id },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return c.json(result as z.infer<typeof PublishResponse>, 200);
  },
  addRoute: true,
});
