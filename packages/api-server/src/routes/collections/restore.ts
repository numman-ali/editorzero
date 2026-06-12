/**
 * `POST /collections/restore/:collection_id` — revive a soft-deleted
 * collection (collection.restore surface, invariant 4; soft-delete
 * recoverability, invariant 6).
 *
 * **Code-first shape (ADR 0029) — see `docs/create.ts` for the golden.**
 * A self-contained `Hono<ApiEnv>` sub-app built from three chained
 * handlers via `factory.createHandlers(...)`:
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (per-status
 *      response schemas). Documents the contract; does not feed `hc`.
 *   2. `validator("param", Schema, hook)` — Standard-Schema validation of
 *      the path param. The hook projects a parse failure to the
 *      `{ error: "validation_failed" }` envelope at 400 (a malformed
 *      `collection_id` → 400 before the handler runs). Like the principal
 *      middleware's 401, this is a cross-cutting middleware return, not an
 *      `hc` arm.
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches, and returns the dispatcher's output through `c.json`.
 *      The dispatcher *throws* `EditorZeroError` subclasses; the handler
 *      catches and maps them with `errorResponse(c, err)` to explicit,
 *      literal-typed `c.json` returns — those explicit returns are what
 *      `hc<AppType>` reads to infer the error arms (ADR 0029 §4).
 *
 * **Param schema — reused, not re-declared (ADR 0034).** The
 * `collection.restore` capability input *is* the single-id object, so the
 * route feeds `CollectionRestoreInputSchema` straight to `validator("param", …)`:
 * the wire shape (`z.input` — a UUIDv7 string) types the `hc` request,
 * `c.req.valid("param")` hands the handler the branded `z.output`
 * (`{ collection_id: CollectionId }`), and that branded object *is* the
 * dispatcher input — no separate `{ collection_id }` re-spelling. The
 * response narrows through `CollectionRestoreOutputSchema.parse(result)`:
 * the honest `unknown`→typed narrowing (a drift surfaces as a ZodError →
 * 500, not a silent lie), zero `as` casts.
 *
 * **Status — 200 OK.** A restore mutates existing state rather than
 * minting a resource; the body echoes `collection_id` for follow-ups.
 *
 * **Error arms.** `NotFoundError` → 404 (collection absent or already
 * live); `ParentDeletedError` → 409 (the parent collection is itself
 * soft-deleted or missing — restore it first, else the tree would be
 * inconsistent); `SlugCollisionError` → 409 (a live sibling claimed the
 * trashed collection's slug while it sat in the trash — rename or delete
 * the holder first; Step-8 slice-2b fix-forward). `errorResponse` maps
 * all three; the 409 `error` code discriminates the two causes.
 *
 * **Audit + permission + dispatcher-tx live inside the dispatcher.** This
 * is a metadata-only mutation (ADR 0018 §7); the handler only dispatches.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  CollectionRestoreInputSchema,
  CollectionRestoreOutputSchema,
} from "@editorzero/schemas/collection/restore";
import { Hono } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const COLLECTION_RESTORE_ID = CapabilityId("collection.restore");

export const restore = new Hono<ApiEnv>().post(
  "/restore/:collection_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["collections"],
      summary: "Restore a soft-deleted collection; refuses if the parent is soft-deleted.",
      responses: {
        200: {
          description: "Restored — echoes id.",
          content: jsonContent(CollectionRestoreOutputSchema),
        },
        400: {
          description: "Validation error — malformed collection_id.",
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
          description: "The collection does not exist or is already live.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "Restore precondition failed. `parent_deleted` = the parent collection is " +
            "soft-deleted or missing, or the space this collection is bound to is " +
            "archived — restore the parent first (`collection.restore` / " +
            "`space.restore`). `slug_collision` = a live sibling claimed this " +
            "collection's slug while it was trashed (rename or delete the holder " +
            "first). The `error` code discriminates.",
          content: jsonContent(z.object({ error: z.enum(["parent_deleted", "slug_collision"]) })),
        },
      },
    }),
    validator("param", CollectionRestoreInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("param");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: COLLECTION_RESTORE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(CollectionRestoreOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
