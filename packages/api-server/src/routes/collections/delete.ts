/**
 * `POST /collections/delete/:collection_id` — collection.delete surface
 * (invariant 4), in the code-first shape (ADR 0029 / 0034).
 *
 * **Pattern P2 — path param only.** The capability input *is* the
 * single-id object (`{ collection_id }`), so `CollectionDeleteInputSchema`
 * doubles as the `param` validator: `validator("param", …)` types the
 * `hc` path param as the wire shape (plain UUIDv7) while
 * `c.req.valid("param")` hands the handler the branded `InferOutput`. No
 * separate params schema is declared — reusing the capability schema is
 * the point of this migration (ADR 0034); the wire contract cannot drift
 * from the capability because there is no copy.
 *
 * Three chained handlers via `factory.createHandlers(...)`:
 *   1. `describeRoute({ … })` — OpenAPI metadata only (per-status response
 *      schemas). Documents the contract; does not feed `hc`.
 *   2. `validator("param", CollectionDeleteInputSchema, hook)` — the hook
 *      projects a malformed `collection_id` to `{ error: "validation_failed" }`
 *      at 400 (a cross-cutting middleware return, intentionally not an
 *      `hc` arm — like the principal middleware's 401; see `lib/errors.ts`).
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches, and returns the dispatcher's output through `c.json`.
 *      The dispatcher *throws* `EditorZeroError` subclasses; the handler
 *      catches and maps them with `errorResponse(c, err)` to explicit,
 *      literal-typed `c.json` returns — those explicit returns are what
 *      `hc<AppType>` reads to infer the error arm (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` (the
 * `user | agent` union); the handler only reads `workspace_id` (on both
 * arms). `dispatch` returns `Promise<unknown>`; the handler *parses* that
 * through `CollectionDeleteOutputSchema.parse` — the honest `unknown`→typed
 * narrowing, never an assertion (a drift surfaces as a ZodError → 500).
 *
 * **Status — 200 OK.** A soft-delete returns the post-state metadata
 * (id + `deleted_at` anchor), not a create. **409 has_live_descendants**
 * when the target still has live direct children (child collections or
 * docs); empty the collection first.
 *
 * **Audit + permission + dispatcher-tx live inside the dispatcher.** The
 * handler only dispatches; metadata mutations are dispatcher-tx-only
 * (invariant 7 / ADR 0018).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  CollectionDeleteInputSchema,
  CollectionDeleteOutputSchema,
} from "@editorzero/schemas/collection/delete";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const COLLECTION_DELETE_ID = CapabilityId("collection.delete");

export const del = new Hono<ApiEnv>().post(
  "/delete/:collection_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["collections"],
      summary: "Soft-delete a collection; refuses if live descendants remain.",
      responses: {
        200: {
          description: "Soft-deleted — echoes id + deleted_at anchor.",
          content: jsonContent(CollectionDeleteOutputSchema),
        },
        400: {
          description: "Validation error (malformed collection_id).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `doc:delete`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "The collection does not exist or is already soft-deleted.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "Live descendants exist (child collections or docs); empty the collection first.",
          content: jsonContent(errEnvelope("has_live_descendants")),
        },
      },
    }),
    validator("param", CollectionDeleteInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("param");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: COLLECTION_DELETE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(CollectionDeleteOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
