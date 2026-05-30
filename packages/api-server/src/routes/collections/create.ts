/**
 * `POST /collections/create` — collection.create surface (invariant 4).
 *
 * Metadata-only mutation route, code-first shape (ADR 0029). Sibling of
 * `/docs/create` but no Y.Doc interaction (collections are pure relational
 * metadata); the dispatcher's write-path tx still governs the INSERT
 * (ADR 0018 — `METADATA_ONLY_CAPABILITIES`).
 *
 * Built from `factory.createHandlers(...)` like every capability route:
 *   1. `describeRoute({ ... })` — OpenAPI metadata only (per-status
 *      response schemas). Documents the contract; does not feed `hc`.
 *   2. `validator("json", CollectionCreateInputSchema, hook)` —
 *      Standard-Schema request validation. The hook projects a parse
 *      failure to the `{ error: "validation_failed" }` envelope at 400
 *      (a cross-cutting middleware return, intentionally not an `hc` arm).
 *   3. The handler — reads `c.var.principal` + `c.var.dispatcher`,
 *      dispatches, and returns the dispatcher's output through `c.json`.
 *      The dispatcher *throws* `EditorZeroError` subclasses; the handler
 *      catches and maps them with `errorResponse(c, err)` to explicit,
 *      literal-typed `c.json` returns — those explicit returns are what
 *      `hc<AppType>` reads to infer the error arms (ADR 0029 §4).
 *
 * **No type casts (`as`).** `c.var.principal` stays `Principal` (the
 * `user | agent` union); the handler only reads `workspace_id` (present
 * on both arms) and forwards `principal` to the dispatcher. `dispatch`
 * returns `Promise<unknown>`; the handler *parses* it through
 * `CollectionCreateOutputSchema` (the honest `unknown`→typed narrowing,
 * and a runtime guard that the output still satisfies the published
 * contract) rather than asserting with `as`.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `CollectionCreateInputSchema` / `CollectionCreateOutputSchema` from
 * `@editorzero/schemas/collection/create` are the single source the
 * capability also consumes — no wire copy to drift.
 *
 * **Status — 201 Created**, matching `/docs/create` (a POST that creates
 * a resource returns 201).
 *
 * **404 response** on a non-existent / soft-deleted `parent_id`. The
 * capability surfaces this as `NotFoundError` with `subject_kind:
 * "collection"`; `errorResponse` projects it to `{ error: "not_found" }`.
 *
 * **409 response** — `SlugCollisionError` (sibling-slug collision,
 * `code: "slug_collision"`) when the derived slug is already taken by a
 * live sibling under the same parent. Body is `{ error: "slug_collision" }`.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  CollectionCreateInputSchema,
  CollectionCreateOutputSchema,
} from "@editorzero/schemas/collection/create";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const COLLECTION_CREATE_ID = CapabilityId("collection.create");

export const create = new Hono<ApiEnv>().post(
  "/create",
  ...factory.createHandlers(
    describeRoute({
      tags: ["collections"],
      summary: "Create a new collection in the caller's workspace.",
      responses: {
        201: {
          description: "Created — collection metadata.",
          content: jsonContent(CollectionCreateOutputSchema),
        },
        400: {
          description: "Validation error (empty/whitespace-only title, or malformed parent_id).",
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
          description: "The referenced `parent_id` does not exist or is soft-deleted.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description: "Sibling-slug collision — derived slug is already taken by a live sibling.",
          content: jsonContent(errEnvelope("slug_collision")),
        },
      },
    }),
    validator("json", CollectionCreateInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("json");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: COLLECTION_CREATE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(CollectionCreateOutputSchema.parse(result), 201);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
