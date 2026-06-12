/**
 * `POST /docs/remove_guest/:doc_id` — doc.remove_guest surface
 * (invariant 4).
 *
 * Code-first route (ADR 0029 / 0034): pattern P3 — the path param
 * carries `doc_id`, the JSON body carries the edge address
 * `{subject_kind, subject_id}`. Param / Body schemas are the schema
 * module's pre-split exports.
 *
 * **Status codes.**
 *   200 — guest edge hard-deleted; echoes the FULL preimage (this
 *         response + the `acl.revoke` audit row are the only durable
 *         record of what was removed).
 *   400 — schema failure (malformed `doc_id`, unknown subject_kind,
 *         empty subject_id; `role` does not belong on this verb).
 *   401 — unauthenticated.
 *   403 — permission denied: missing `permission:revoke`, or the
 *         administer ladder denied over the doc's STORED placement.
 *   404 — the doc row is missing entirely, OR no edge exists for this
 *         (subject_kind, subject_id) on the doc. NOTE: a soft-deleted
 *         doc is NOT 404 here — removal works on trash (otherwise
 *         guest edges in trash would be immortal: permission.revoke
 *         refuses them).
 *   409 — `grant_lifecycle_conflict`: the addressed edge is a
 *         NON-guest grant — standing-backed access is removed via
 *         permission.revoke, not this verb.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  DocRemoveGuestBodySchema,
  DocRemoveGuestOutputSchema,
  DocRemoveGuestParamSchema,
} from "@editorzero/schemas/doc/remove_guest";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const DOC_REMOVE_GUEST_ID = CapabilityId("doc.remove_guest");

export const removeGuest = new Hono<ApiEnv>().post(
  "/remove_guest/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Hard-delete a guest edge by (doc, subject) address; echoes the full preimage.",
      responses: {
        200: {
          description:
            "Guest edge deleted — echoes the full preimage (the durable record of what was removed).",
          content: jsonContent(DocRemoveGuestOutputSchema),
        },
        400: {
          description: "Validation error — malformed param/body.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description:
            "Permission denied — missing `permission:revoke`, or the administer ladder denied over the doc's stored placement.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description:
            "Doc row missing entirely, or no edge exists for this subject on the doc. Soft-deleted docs are NOT 404 — removal works on trash.",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "The addressed edge is a NON-guest grant — standing-backed access is removed via permission.revoke.",
          content: jsonContent(errEnvelope("grant_lifecycle_conflict")),
        },
      },
    }),
    validator("param", DocRemoveGuestParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", DocRemoveGuestBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: DOC_REMOVE_GUEST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocRemoveGuestOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
