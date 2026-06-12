/**
 * `permission.revoke` — hard-DELETE a non-guest ACL edge by grant id
 * (ADR 0040 Step 8, H1 lifecycle; Appendix A row; invariant 5).
 * Metadata-only mutation; `permission:revoke` scope (member-wide — the
 * REAL bound is the granting-authority ladder, same as
 * `permission.grant`).
 *
 * **Flow.**
 *   1. SELECT the grant by id — absent (or cross-tenant, which the
 *      scoping plugin makes indistinguishable from absent) → 404
 *      `not_found` with `subject_kind: "grant"`.
 *   2. GUEST edges are refused (`ValidationError` routing to
 *      `doc.remove_guest`): the guest lifecycle owns its own
 *      bookkeeping, and revoking through the generic verb would bypass
 *      it. No guest edge can exist before `doc.add_guest` ships, so
 *      this rail has no reachable dead-end today.
 *   3. SELECT the resource row — authority is evaluated against the
 *      RESOURCE, not the grant row:
 *        - doc grants: row missing entirely = ORPHAN (should be
 *          impossible — `doc.purge` enumerates + hard-deletes its
 *          grants; a survivor means out-of-band damage) → 404 on the
 *          doc; the grant stays inert until repair. A SOFT-DELETED doc
 *          row still authorizes: revoking access to a trashed doc is
 *          the offboarding posture (the grant would resurrect on
 *          restore; forcing a restore first — making content readable
 *          again to trim its ACL — would be a security anti-pattern).
 *          `assertCanAdministerDoc` evaluates the trashed row's stored
 *          placement, same as `doc.restore`.
 *        - space grants: row missing = orphan → 404 on the space.
 *          A soft-deleted space fails closed in
 *          `assertCanAdministerSpace` (the ladder never administers
 *          trashed spaces) → 403 `acl_deny` — restore-first posture,
 *          asymmetric with docs BY the predicate's design: the space
 *          ladder needs the live row's kind/type/owner to evaluate at
 *          all.
 *   4. DELETE by id with RETURNING — zero rows means a concurrent
 *      revoke won the race → 404 (the edge is already gone; same
 *      terminal state, honest signal). The RETURNING row — not the
 *      step-1 SELECT — is the output preimage, so the response and the
 *      `acl.revoke` effect carry exactly what was deleted.
 *
 * **Output = the FULL row preimage** (Codex Step-7 HIGH 1): grants are
 * hard-DELETEd, so this response and its audit row are the only
 * durable record of what access was removed.
 *
 * **Subject.** `{kind: "grant", id: grant_id}` — the edge itself; the
 * resource and grantee are in the effect payload.
 */

import type { AuditDeny, AuditEffect, DenyReason, HandlerError } from "@editorzero/audit";
import { NotFoundError, ValidationError } from "@editorzero/errors";
import { CapabilityId, DocId, SpaceId } from "@editorzero/ids";
import {
  type PermissionRevokeInput,
  PermissionRevokeInputSchema,
  type PermissionRevokeOutput,
  PermissionRevokeOutputSchema,
} from "@editorzero/schemas/permission/revoke";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const PERMISSION_REVOKE_ID = CapabilityId("permission.revoke");

const GRANT_ROW_COLUMNS = [
  "id",
  "workspace_id",
  "resource_kind",
  "resource_id",
  "subject_kind",
  "subject_id",
  "role",
  "is_guest",
  "created_by",
  "created_at",
] as const;

interface GrantRow {
  readonly id: PermissionRevokeOutput["grant_id"];
  readonly workspace_id: PermissionRevokeOutput["workspace_id"];
  readonly resource_kind: PermissionRevokeOutput["resource_kind"];
  readonly resource_id: string;
  readonly subject_kind: PermissionRevokeOutput["subject_kind"];
  readonly subject_id: string;
  readonly role: PermissionRevokeOutput["role"];
  readonly is_guest: PermissionRevokeOutput["is_guest"];
  readonly created_by: PermissionRevokeOutput["created_by"];
  readonly created_at: number;
}

function toOutput(row: GrantRow): PermissionRevokeOutput {
  return {
    grant_id: row.id,
    workspace_id: row.workspace_id,
    resource_kind: row.resource_kind,
    resource_id: row.resource_id,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    role: row.role,
    is_guest: row.is_guest,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

// ── Capability ───────────────────────────────────────────────────────────

export const permissionRevoke: Capability<PermissionRevokeInput, PermissionRevokeOutput> = {
  id: PERMISSION_REVOKE_ID,
  category: "mutation",
  summary: "Hard-delete a non-guest ACL edge by grant id; echoes the full preimage.",
  input: PermissionRevokeInputSchema,
  output: PermissionRevokeOutputSchema,
  requires: ["permission:revoke"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({
      kind: "grant",
      id: input.grant_id,
    }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "acl.revoke",
      grant_id: output.grant_id,
      workspace_id: output.workspace_id,
      resource_kind: output.resource_kind,
      resource_id: output.resource_id,
      subject_kind: output.subject_kind,
      subject_id: output.subject_id,
      role: output.role,
      is_guest: output.is_guest,
      created_by: output.created_by,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: PERMISSION_REVOKE_ID,
      required_scopes: ["permission:revoke"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(PERMISSION_REVOKE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    // Step 1 — the edge itself.
    const grant = await ctx.db
      .selectFrom("grants")
      .select(GRANT_ROW_COLUMNS)
      .where("id", "=", input.grant_id)
      .executeTakeFirst();
    if (grant === undefined) {
      throw new NotFoundError({ subject_kind: "grant", subject_id: input.grant_id });
    }

    // Step 2 — guest edges have their own lifecycle verb.
    if (grant.is_guest === 1) {
      throw new ValidationError({
        message:
          "permission.revoke: this edge is a GUEST grant; guest access is removed " +
          "via doc.remove_guest (it owns the guest lifecycle's bookkeeping).",
        issues: [
          {
            code: "guest_grant_requires_remove_guest",
            message: "is_guest = 1 edges are managed by doc.add_guest / doc.remove_guest",
            path: ["grant_id"],
          },
        ],
      });
    }

    // Step 3 — authority against the resource (see header for the
    // orphan / trashed-doc / trashed-space postures).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    if (grant.resource_kind === "doc") {
      const doc = await ctx.db
        .selectFrom("docs")
        .select(["id", "created_by", "access_mode", "collection_id"])
        .where("id", "=", DocId(grant.resource_id))
        .executeTakeFirst();
      if (doc === undefined) {
        throw new NotFoundError({ subject_kind: "doc", subject_id: grant.resource_id });
      }
      acl.assertCanAdministerDoc(doc);
    } else {
      const space = await ctx.db
        .selectFrom("spaces")
        .select(["id"])
        .where("id", "=", SpaceId(grant.resource_id))
        .executeTakeFirst();
      if (space === undefined) {
        throw new NotFoundError({ subject_kind: "space", subject_id: grant.resource_id });
      }
      acl.assertCanAdministerSpace(SpaceId(grant.resource_id));
    }

    // Step 4 — hard DELETE; RETURNING is the authoritative preimage.
    const deleted = await ctx.db
      .deleteFrom("grants")
      .where("id", "=", input.grant_id)
      .returning(GRANT_ROW_COLUMNS)
      .executeTakeFirst();
    if (deleted === undefined) {
      // Concurrent revoke won between step 1 and here — the edge is
      // already gone. 404 keeps the terminal state honest.
      throw new NotFoundError({ subject_kind: "grant", subject_id: input.grant_id });
    }
    return toOutput(deleted);
  },
};
