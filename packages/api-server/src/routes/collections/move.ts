/**
 * `POST /collections/move/:collection_id` — collection.move surface
 * (invariant 4). Code-first shape (ADR 0029); shared schema reused, not
 * re-declared (ADR 0034). See `routes/docs/create.ts` for the golden
 * shape this mirrors.
 *
 * Metadata-only mutation. Re-parents a collection within the workspace
 * under a different parent (or the workspace root via
 * `new_parent_id: null`).
 *
 * **Pattern P3 — path param + JSON body merged into one capability
 * input.** The capability takes a single `CollectionMoveInput`
 * (`{ collection_id, new_parent_id }`), but the wire splits it: the
 * `collection_id` rides the path, `new_parent_id` rides the body. Rather
 * than re-declare two ad-hoc wire schemas (the drift the migration
 * removes), the route derives both halves from the ONE shared
 * `CollectionMoveInputSchema` via `.pick()` — which preserves each
 * field's `.transform()` (wire string → branded `CollectionId`) and the
 * object's `.strict()` (unknown body keys → 400). Two `validator`s
 * (`param` + `json`), each with the same hook projecting a parse failure
 * to the `{ error: "validation_failed" }` envelope at 400. The handler
 * re-merges the two branded halves into the capability input.
 *
 * **No type casts (`as`).** `c.var.principal` stays the `Principal`
 * union — both arms carry `workspace_id`, and the dispatcher accepts the
 * union (invariant 8). `dispatch` returns `Promise<unknown>`; the handler
 * *parses* that through `CollectionMoveOutputSchema` (the honest
 * `unknown`→typed narrowing + a runtime drift guard) rather than asserting
 * a type. The only `as` is the hook's literal `{ error: "validation_failed" } as const`.
 *
 * **Status — 200 OK.** Re-parent mutates existing state; no resource is
 * created. Body carries the post-move metadata.
 *
 * **Error arms (mapped from thrown `EditorZeroError` via `errorResponse`).**
 *   400 — `ValidationError`: cycle detection (`cycle_detected`) or
 *         depth-cap exceeded (`depth_cap_exceeded`); also a malformed
 *         body/param rejected by the validators. All converge on
 *         `{ error: "validation_failed" }`.
 *   401 — unauthenticated (cross-cutting middleware return; declared only).
 *   403 — permission denied; caller lacks `doc:write`.
 *   404 — moved collection or target parent missing / soft-deleted.
 *   409 — `SlugCollisionError`: moved collection's slug clashes with a
 *         live sibling under the target parent. Race window (pre-check →
 *         UPDATE) stays guarded by the partial unique index.
 *
 * The route mounts at a path **relative** to its domain (`/move/:collection_id`);
 * the `collections` domain mounts at `/collections` on the trunk, so the
 * external path is `/collections/move/:collection_id`.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  CollectionMoveInputSchema,
  CollectionMoveOutputSchema,
} from "@editorzero/schemas/collection/move";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const COLLECTION_MOVE_ID = CapabilityId("collection.move");

// Derive the path-param and body halves from the ONE capability schema.
// `.pick()` preserves each field's `.transform()` (→ branded `CollectionId`)
// and the parent object's `.strict()` (unknown body keys → 400).
const ParamSchema = CollectionMoveInputSchema.pick({ collection_id: true });
const BodySchema = CollectionMoveInputSchema.pick({ new_parent_id: true });

export const move = new Hono<ApiEnv>().post(
  "/move/:collection_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["collections"],
      summary:
        "Re-parent a collection. Refuses cycles, preserves the depth cap, enforces target-scope slug uniqueness.",
      responses: {
        200: {
          description: "Moved — post-move metadata.",
          content: jsonContent(CollectionMoveOutputSchema),
        },
        400: {
          description: "Validation error (cycle, depth-cap exceeded, or malformed body/param).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description: "Permission denied — caller lacks `doc:write`.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description:
            "The moved collection or the target parent does not exist or is soft-deleted.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "Sibling-slug collision — moved collection's slug is already taken by a live sibling under the target parent.",
          content: jsonContent(errEnvelope("slug_collision")),
        },
      },
    }),
    validator("param", ParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", BodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: COLLECTION_MOVE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(CollectionMoveOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
