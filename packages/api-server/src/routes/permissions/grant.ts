/**
 * `POST /permissions/grant` — permission.grant surface (invariant 4).
 * Code-first shape (ADR 0029); see `docs/create.ts` for the golden
 * reference and `workspaces/member_add.ts` for the metadata-mutation
 * sibling this mirrors.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `PermissionGrantInputSchema` / `PermissionGrantOutputSchema` from
 * `@editorzero/schemas/permission/grant` are the single source the
 * capability also consumes. `dispatch` returns `unknown`; the handler
 * narrows it with `PermissionGrantOutputSchema.parse` — never an `as`.
 *
 * Metadata-only mutation; scope `permission:grant` (member-wide — the
 * granting-authority ladder inside the capability is the real bound).
 *
 * **Status — 200 OK** (upsert, not create: fresh edge, idempotent
 * re-grant, and role convergence all end in "this edge now exists with
 * role X"; callers distinguishing them read `created_at` vs the role
 * they sent). Echoes the full grant row.
 *
 * **400 — `validation_failed`.** Malformed body (strict keys, unknown
 * role/kind, non-UUIDv7 resource_id) — and the handler's typed subject
 * rules: a user subject who is not a live workspace member, or who
 * lacks standing in the doc's Space (the guest flow belongs to
 * `doc.add_guest`).
 *
 * **404 — `not_found`.** Resource missing or soft-deleted (trash-
 * invisible posture: granting against trash is refused without
 * confirming existence).
 *
 * **403 — `permission_denied`.** Caller lacks the L1 scope, or the
 * granting-authority ladder denied (`acl_deny` on the resource).
 *
 * **409 — two codes.** `grant_lifecycle_conflict`: the edge exists as
 * a GUEST grant — managed via `doc.add_guest`/`doc.remove_guest`, not
 * here (typed so surfaces route the caller to the right verb instead
 * of generic retry copy). `conflict`: a concurrent grant/revoke raced
 * this upsert; re-read and retry.
 */

import { CapabilityId } from "@editorzero/ids";
import {
  PermissionGrantInputSchema,
  PermissionGrantOutputSchema,
} from "@editorzero/schemas/permission/grant";
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

const PERMISSION_GRANT_ID = CapabilityId("permission.grant");

export const grant = new Hono<ApiEnv>().post(
  "/grant",
  ...factory.createHandlers(
    describeRoute({
      tags: ["permissions"],
      summary: "Create or converge a non-guest ACL edge on a doc or space.",
      responses: {
        200: {
          description:
            "Edge upserted — fresh INSERT, idempotent re-grant, or role convergence under the same grant_id. Echoes the full grant row.",
          content: jsonContent(PermissionGrantOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed body; the subject rules (user subject not a live workspace member / without standing in the doc's Space — use doc.add_guest); or the doc's placement is anomalous (repair-first: space.restore or doc.move, then grant).",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description:
            "Permission denied — missing `permission:grant`, or the granting-authority ladder denied on the resource.",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description: "Resource missing or soft-deleted (trash-invisible).",
          content: jsonContent(errEnvelope("not_found")),
        },
        409: {
          description:
            "`grant_lifecycle_conflict` — edge exists as a guest grant (managed via doc.add_guest / doc.remove_guest); `conflict` — a concurrent grant/revoke raced this upsert.",
          content: jsonContent(errEnvelopeOneOf("grant_lifecycle_conflict", "conflict")),
        },
      },
    }),
    validator("json", PermissionGrantInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("json");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: PERMISSION_GRANT_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(PermissionGrantOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
