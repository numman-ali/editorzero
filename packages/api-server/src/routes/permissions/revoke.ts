/**
 * `POST /permissions/revoke` — permission.revoke surface (invariant 4).
 * Code-first shape (ADR 0029); mirrors `permissions/grant.ts`.
 *
 * **Request + response schemas — reused, not re-declared (ADR 0034).**
 * `PermissionRevokeInputSchema` / `PermissionRevokeOutputSchema` from
 * `@editorzero/schemas/permission/revoke`. Body carries `{grant_id}` —
 * not a path param because the derivation convention's param name for
 * this domain is `permission_id` (ADR 0021), which no input declares.
 *
 * **Status — 200 OK.** Edge hard-deleted; the response is the FULL row
 * preimage (H1: the row no longer exists — this echo and the
 * `acl.revoke` audit row are the only durable record).
 *
 * **400 — `validation_failed`.** Malformed body — or a guest edge
 * (`is_guest = 1`), whose lifecycle belongs to `doc.remove_guest`.
 *
 * **404 — `not_found`.** Unknown / cross-tenant / concurrently-revoked
 * grant id (`grant`), or an orphaned edge whose resource row is gone
 * (`doc` / `space` — inert until repair).
 *
 * **403 — `permission_denied`.** Caller lacks the L1 scope, or the
 * granting-authority ladder denied on the resource — including the
 * trashed-space restore-first posture (a soft-deleted space is never
 * administerable; restore it, then revoke).
 */

import { CapabilityId } from "@editorzero/ids";
import {
  PermissionRevokeInputSchema,
  PermissionRevokeOutputSchema,
} from "@editorzero/schemas/permission/revoke";
import { Hono } from "hono";

import type { ApiEnv } from "../../env";
import { errorResponse } from "../../lib/errors";
import { describeRoute, errEnvelope, factory, jsonContent, validator } from "../../lib/openapi";

const PERMISSION_REVOKE_ID = CapabilityId("permission.revoke");

export const revoke = new Hono<ApiEnv>().post(
  "/revoke",
  ...factory.createHandlers(
    describeRoute({
      tags: ["permissions"],
      summary: "Hard-delete a non-guest ACL edge by grant id; echoes the full preimage.",
      responses: {
        200: {
          description:
            "Edge deleted. Response is the full row preimage — the only durable record besides the acl.revoke audit row (H1 hard-DELETE lifecycle).",
          content: jsonContent(PermissionRevokeOutputSchema),
        },
        400: {
          description:
            "Validation error — malformed body, or a guest edge (is_guest = 1): guest access is removed via doc.remove_guest.",
          content: jsonContent(errEnvelope("validation_failed")),
        },
        401: {
          description: "Unauthenticated.",
          content: jsonContent(errEnvelope("unauthenticated")),
        },
        403: {
          description:
            "Permission denied — missing `permission:revoke`, or the granting-authority ladder denied (including the trashed-space restore-first posture).",
          content: jsonContent(errEnvelope("permission_denied")),
        },
        404: {
          description:
            "Unknown, cross-tenant, or concurrently-revoked grant id; or an orphaned edge whose resource row no longer exists.",
          content: jsonContent(errEnvelope("not_found")),
        },
      },
    }),
    validator("json", PermissionRevokeInputSchema, (result, c) =>
      result.success ? undefined : c.json({ error: "validation_failed" } as const, 400),
    ),
    async (c) => {
      const principal = c.var.principal;
      const input = c.req.valid("json");
      try {
        const result = await c.var.dispatcher.dispatch({
          capability_id: PERMISSION_REVOKE_ID,
          input,
          principal,
          access: { workspace_id: principal.workspace_id },
          trace_id: null,
        });
        return c.json(PermissionRevokeOutputSchema.parse(result), 200);
      } catch (err) {
        return errorResponse(c, err);
      }
    },
  ),
);
