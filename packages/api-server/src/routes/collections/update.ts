/**
 * `POST /collections/update/:collection_id` — collection.update surface
 * (invariant 4). Code-first shape per ADR 0029; reuses the shared
 * capability schema per ADR 0034 (no wire re-declaration).
 *
 * Metadata-only mutation. Renames a collection; slug is derived from
 * title via `slugify` (same derivation as `collection.create` /
 * `doc.rename`). Audit + permission + dispatcher-tx live inside the
 * dispatcher; the handler only dispatches.
 *
 * **Pattern P3 — path param + JSON body merged into one capability
 * input.** The capability input (`CollectionUpdateInputSchema`) spans
 * both the URL (`collection_id`) and the body (`title`). Rather than
 * re-declare two ad-hoc schemas, derive each wire piece from the ONE
 * shared schema with `.pick()` — proven to preserve the per-field
 * `.transform()` (UUIDv7→brand, title trim+min1) and the parent
 * `.strict()`. Two `validator(...)`s (one `"param"`, one `"json"`)
 * share a hook that projects a parse failure to the runtime
 * `{ error: "validation_failed" }` envelope at 400. The handler merges
 * the two branded halves back into the single capability input.
 *
 * **No type casts (`as`).** `c.var.principal` stays the `user | agent`
 * union; the handler reads only `workspace_id` (on both arms) and
 * forwards `principal` to the dispatcher. `dispatch` returns
 * `Promise<unknown>`; the handler *parses* it through
 * `CollectionUpdateOutputSchema` rather than asserting — the honest
 * `unknown`→typed narrowing and a runtime drift guard. The dispatcher
 * *throws* `EditorZeroError` subclasses; the handler catches and maps
 * them via `errorResponse(c, err)` to literal-typed `c.json` returns —
 * those explicit returns are what `hc<AppType>` reads for the error arms.
 *
 * **Status — 200 OK** (an update, not a create). The mounted path is
 * relative to the `collections` domain (`/update/:collection_id`); the
 * domain mounts at `/collections`, so the external path is
 * `/collections/update/:collection_id`.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  CollectionUpdateInputSchema,
  CollectionUpdateOutputSchema,
} from "@editorzero/schemas/collection/update";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const COLLECTION_UPDATE_ID = CapabilityId("collection.update");

// Derive each wire piece from the ONE capability schema (`.pick()`
// preserves the per-field transform + the parent `.strict()`).
const ParamSchema = CollectionUpdateInputSchema.pick({ collection_id: true });
const BodySchema = CollectionUpdateInputSchema.pick({ title: true });

export const update = new Hono<ApiEnv>().post(
  "/update/:collection_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["collections"],
      summary: "Rename a collection (title → slug derivation). Metadata-only.",
      responses: {
        200: {
          description: "Updated — post-rename metadata.",
          content: jsonContent(CollectionUpdateOutputSchema),
        },
        400: {
          description:
            "Validation error (empty/whitespace-only title, or malformed collection_id).",
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
          description: "The collection does not exist or is soft-deleted.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description: "Sibling-slug collision — derived slug is already taken by a live sibling.",
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
          capability_id: COLLECTION_UPDATE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(CollectionUpdateOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
