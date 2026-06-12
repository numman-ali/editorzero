/**
 * `POST /docs/add_guest/:doc_id` — doc.add_guest surface (invariant 4).
 *
 * Code-first route (ADR 0029 / 0034): pattern P3 — the path param
 * carries `doc_id`, the JSON body carries `{subject_kind, subject_id,
 * role}`, and the two halves merge into the capability input. Param /
 * Body schemas are the schema module's own pre-split exports
 * (`DocAddGuestParamSchema` / `DocAddGuestBodySchema`) — derived from
 * the same base object the capability parses, no re-stated copy.
 *
 * **Status codes.**
 *   200 — guest edge upserted (fresh mint, idempotent re-add, or role
 *         convergence under the same grant_id). Echoes the full grant
 *         row (`is_guest` is structurally 1).
 *   400 — schema failure: malformed `doc_id`, unknown subject_kind,
 *         empty subject_id, or a guest `owner` role (unmintable BY
 *         SCHEMA — `GuestGrantRoleSchema` excludes it). Also the
 *         unattributable workspace-owned agent caller.
 *   401 — unauthenticated.
 *   403 — permission denied: missing `permission:grant`, or the
 *         administer ladder denied on the doc.
 *   404 — doc missing or soft-deleted (trash-invisible; restore first).
 *   409 — `grant_lifecycle_conflict`: the edge exists as a NON-guest
 *         grant — revoke via permission.revoke first (typed lane
 *         routing). `conflict`: a concurrent writer raced the upsert.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  DocAddGuestBodySchema,
  DocAddGuestOutputSchema,
  DocAddGuestParamSchema,
} from "@editorzero/schemas/doc/add_guest";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import {
  describeRoute,
  errEnvelope,
  errEnvelopeOneOf,
  factory,
  jsonContent,
  validator,
} from "../../lib/openapi";

const DOC_ADD_GUEST_ID = CapabilityId("doc.add_guest");

export const addGuest = new Hono<ApiEnv>().post(
  "/add_guest/:doc_id",
  ...factory.createHandlers(
    describeRoute({
      tags: ["docs"],
      summary: "Mint or converge the explicit is_guest=1 ceiling-crossing edge on a doc.",
      responses: {
        200: {
          description:
            "Guest edge upserted — fresh mint, idempotent re-add, or role convergence under the same grant_id. Echoes the full grant row.",
          content: jsonContent(DocAddGuestOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed param/body (guest `owner` is unmintable by schema), or an unattributable workspace-owned agent caller.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description:
            "Permission denied — missing `permission:grant`, or the administer ladder denied on the doc.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Doc missing or soft-deleted (trash-invisible; doc.restore first).",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "`grant_lifecycle_conflict` — the edge exists as a NON-guest grant (revoke via permission.revoke first); `conflict` — a concurrent writer raced the upsert.",
          content: jsonContent(errEnvelopeOneOf("grant_lifecycle_conflict", "conflict")),
        },
      },
    }),
    validator("param", DocAddGuestParamSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    validator("json", DocAddGuestBodySchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = { ...c.req.valid("param"), ...c.req.valid("json") };
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: DOC_ADD_GUEST_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(DocAddGuestOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
