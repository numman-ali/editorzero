/**
 * `permission.grant` — create or converge a non-guest ACL edge on a doc
 * or space (ADR 0040 Step 8; Appendix A row; invariant 5).
 * Metadata-only mutation; `permission:grant` scope (member-wide — the
 * REAL bound is the granting-authority ladder below).
 *
 * **Authority — the granting-authority ladder (`acl/ceiling.ts`).**
 * The L1 scope is deliberately coarse; who may grant on WHAT is the
 * resolver's job, evaluated inside the dispatcher tx:
 *   - doc — `assertCanAdministerDoc`: doc owner-tier (creator or
 *     non-guest owner-role doc grant), else by placement (legacy →
 *     workspace owner/admin backstop; space → space owner-tier;
 *     anomaly → owner-tier only). Guest grants NEVER confer authority
 *     (scenario 7 — re-share-proof).
 *   - space — `assertCanAdministerSpace`: personal → `owner_user_id`
 *     only (privacy holds against admins, scenario 3); team → owner
 *     membership / non-guest owner-role space grant / workspace
 *     owner-admin backstop.
 *
 * **404 first (trash-invisible posture, same as `doc.get`).** A
 * missing OR soft-deleted resource is `not_found` before any authority
 * evaluation: granting new access against trash is refused without
 * confirming the resource ever existed. Recovery is `doc.restore` /
 * `space.restore`, then grant.
 *
 * **Subject rules.**
 *   - `user` subjects must hold a LIVE workspace membership row, and —
 *     for docs placed in a Space — baseline reach into that Space *as
 *     the subject* (membership / space grant / open-space baseline /
 *     personal-owner: exactly `hasBaselineReach`, evaluated through a
 *     subject-side resolver so the standing rule cannot drift from the
 *     read ceiling). A user without standing is the GUEST flow: the
 *     typed `ValidationError` routes the caller to `doc.add_guest`,
 *     which mints the explicit `is_guest = 1` escape hatch. Legacy
 *     placements (root / unspaced collection) need membership only —
 *     the pre-Spaces world's baseline is the whole Org. Anomaly
 *     placements (dangling/trashed space ref) REFUSE every grant —
 *     repair-first (Codex slice-1 review MUST-FIX): the ceiling is
 *     unavailable so standing cannot be proven, and an `is_guest = 0`
 *     edge minted in that window would become an unmarked ceiling
 *     crossing the moment `space.restore` revives the binding.
 *     `space.restore` or `doc.move` first, then grant; recovery
 *     sharing, if ever needed mid-anomaly, is `doc.add_guest`'s
 *     explicitly-marked job. `permission.revoke` still works on
 *     anomaly docs (removal mints nothing).
 *   - `agent` subjects skip membership/standing checks: agents are not
 *     Org members and carry NO baseline — a grant is precisely how an
 *     agent acquires resource access, and `is_guest = 0` stays honest
 *     because there is no baseline ceiling being crossed. Agent-row
 *     existence validation is a recorded obligation for the agents
 *     slice (no `agents` table exists yet); until then a granted-but-
 *     nonexistent agent id is an inert, revocable row.
 *   - Space-resource grants need membership only (any placement logic
 *     is doc-side): a space grant IS how space standing is conferred.
 *
 * **Upsert on the unique edge** `(workspace_id, resource_kind,
 * resource_id, subject_kind, subject_id)`:
 *   1. Existing GUEST edge — `ConflictError` (409). Guest lifecycles
 *      belong to `doc.add_guest` / `doc.remove_guest`; silently
 *      flipping `is_guest` 1→0 would erase the audited escape-hatch
 *      marker.
 *   2. Existing non-guest edge, same role — idempotent success: echo
 *      the row unchanged (no UPDATE), re-emit `acl.grant` under the
 *      same `grant_id` (the reducer upserts by id — replay converges;
 *      same posture as `doc.publish`'s idempotent re-publish).
 *   3. Existing non-guest edge, different role — UPDATE `role` only,
 *      same `grant_id`; `created_by`/`created_at` are immutable
 *      (attribution never transfers — ADR 0040). Zero-row return means
 *      a concurrent revoke deleted the row between SELECT and UPDATE →
 *      409 `conflict`, caller re-reads.
 *   4. No edge — fresh INSERT (`is_guest = 0`, caller-attributed
 *      `created_by`, handler-clock `created_at`) wrapped in
 *      `ON CONFLICT (unique edge) DO NOTHING RETURNING`; zero rows
 *      means a concurrent grant won the race → 409 `conflict` (same
 *      rationale as `workspace.member_add` Branch C — the global
 *      mapper deliberately does not project raw unique-violations).
 *
 * **H6 compensating control.** The polymorphic `resource_id` has no
 * FK; the same-tx resource SELECT above (steps run inside the
 * dispatcher write tx — `ctx.db` IS the tx handle for metadata-only
 * capabilities) is the in-tx target-existence check the ADR binds.
 *
 * **`created_by` attribution** follows `doc.create`/`collection.create`
 * (`resolveCreatedBy`): user principals contribute their own id; agent
 * principals `acting_as` (delegated) or `owner_user_id`; workspace-
 * owned agents are refused (`grants.created_by: UserId` needs a human
 * anchor in v1).
 *
 * **Subject.** The RESOURCE the edge is minted on (`resource_kind` is
 * a `SubjectKind` member by construction) — audit reads "what was
 * shared"; the grantee is in the effect payload.
 */

import type { AuditDeny, AuditEffect, DenyReason, HandlerError } from "@editorzero/audit";
import {
  ConflictError,
  GrantLifecycleConflictError,
  NotFoundError,
  ValidationError,
} from "@editorzero/errors";
import { CapabilityId, DocId, generateGrantId, SpaceId, UserId } from "@editorzero/ids";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import {
  type PermissionGrantInput,
  PermissionGrantInputSchema,
  type PermissionGrantOutput,
  PermissionGrantOutputSchema,
} from "@editorzero/schemas/permission/grant";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const PERMISSION_GRANT_ID = CapabilityId("permission.grant");

// ── Helpers ──────────────────────────────────────────────────────────────

function resolveCreatedBy(principal: Principal) {
  if (principal.kind === "user") return principal.id;
  if (principal.acting_as !== undefined) return principal.acting_as;
  if (principal.owner_user_id !== null) return principal.owner_user_id;
  throw new ValidationError({
    message:
      "permission.grant: agent principal has neither `acting_as` nor `owner_user_id` set; " +
      "cannot attribute `grants.created_by` to a human in v1.",
    issues: [
      {
        code: "unattributable_agent",
        message:
          "workspace-owned agent principal requires a delegated `acting_as` " +
          "(agent-auth token) or a non-null `owner_user_id` for permission.grant",
        path: ["principal"],
      },
    ],
  });
}

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
  readonly id: PermissionGrantOutput["grant_id"];
  readonly workspace_id: PermissionGrantOutput["workspace_id"];
  readonly resource_kind: PermissionGrantOutput["resource_kind"];
  readonly resource_id: string;
  readonly subject_kind: PermissionGrantOutput["subject_kind"];
  readonly subject_id: string;
  readonly role: PermissionGrantOutput["role"];
  readonly is_guest: PermissionGrantOutput["is_guest"];
  readonly created_by: PermissionGrantOutput["created_by"];
  readonly created_at: number;
}

function toOutput(row: GrantRow): PermissionGrantOutput {
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

export const permissionGrant: Capability<PermissionGrantInput, PermissionGrantOutput> = {
  id: PERMISSION_GRANT_ID,
  category: "mutation",
  summary: "Create or converge a non-guest ACL edge on a doc or space.",
  input: PermissionGrantInputSchema,
  output: PermissionGrantOutputSchema,
  requires: ["permission:grant"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({
      kind: input.resource_kind,
      id: input.resource_id,
    }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "acl.grant",
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
      capability: PERMISSION_GRANT_ID,
      required_scopes: ["permission:grant"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(PERMISSION_GRANT_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const created_by = resolveCreatedBy(ctx.principal);

    // Step 1 — resource existence + trash posture (404 FIRST, before
    // any authority evaluation — trash-invisible, same as `doc.get`).
    // Loading the caller's resolver after the 404 keeps the deny
    // channel honest: a caller probing ids learns nothing from a 403
    // they couldn't get from the 404.
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);

    let docPlacementSpaceId: SpaceId | null = null;
    if (input.resource_kind === "doc") {
      const doc = await ctx.db
        .selectFrom("docs")
        .select(["id", "created_by", "access_mode", "collection_id", "deleted_at"])
        .where("id", "=", DocId(input.resource_id))
        .executeTakeFirst();
      if (doc === undefined || doc.deleted_at !== null) {
        throw new NotFoundError({ subject_kind: "doc", subject_id: input.resource_id });
      }
      // Step 2 — granting authority on the doc.
      acl.assertCanAdministerDoc(doc);
      const placement = acl.placementOf(doc.collection_id);
      // Anomalous placement (dangling or trashed space ref) refuses ALL
      // grant writes, uniformly across subject kinds and before the
      // edge lookup (Codex slice-1 review MUST-FIX). The ceiling is
      // unavailable, so standing cannot be proven — an `is_guest = 0`
      // edge minted in this window would become an unmarked ceiling
      // crossing the moment `space.restore` revives the binding.
      // Authority ran first, so non-owner-tier callers got acl_deny and
      // learn nothing of placement state; `permission.revoke` stays
      // available on anomaly docs (access removal mints nothing).
      if (placement.kind === "anomaly") {
        throw new ValidationError({
          message:
            "permission.grant: the doc's Space binding is anomalous (missing or " +
            "trashed space); repair first — `space.restore` the space or " +
            "`doc.move` the doc — then grant.",
          issues: [
            {
              code: "anomalous_placement_requires_repair",
              message:
                "no grant can be minted while the doc's placement is anomalous: " +
                "standing cannot be evaluated against an unavailable Space, and a " +
                "non-guest edge minted now would cross the restored ceiling unmarked",
              path: ["resource_id"],
            },
          ],
        });
      }
      if (placement.kind === "space") docPlacementSpaceId = placement.space_id;
    } else {
      const space = await ctx.db
        .selectFrom("spaces")
        .select(["id", "deleted_at"])
        .where("id", "=", SpaceId(input.resource_id))
        .executeTakeFirst();
      if (space === undefined || space.deleted_at !== null) {
        throw new NotFoundError({ subject_kind: "space", subject_id: input.resource_id });
      }
      // Step 2 — granting authority on the space.
      acl.assertCanAdministerSpace(SpaceId(input.resource_id));
    }

    // Step 3 — subject rules (user subjects only; see header).
    if (input.subject_kind === "user") {
      const subjectUserId = UserId(input.subject_id);
      const memberRow = await ctx.db
        .selectFrom("workspace_members")
        .select(["role"])
        .where("user_id", "=", subjectUserId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (memberRow === undefined) {
        throw new ValidationError({
          message:
            "permission.grant: subject user is not a live workspace member; " +
            "cross-workspace sharing is the guest flow (`doc.add_guest`).",
          issues: [
            {
              code: "subject_not_workspace_member",
              message:
                "subject_id has no live workspace membership — add them via " +
                "workspace.member_add, or share the doc via doc.add_guest",
              path: ["subject_id"],
            },
          ],
        });
      }
      if (docPlacementSpaceId !== null) {
        // Space standing — the SUBJECT's own baseline reach into the
        // doc's Space, evaluated through a subject-side resolver so
        // this rule and the read ceiling are the same predicate.
        const subjectPrincipal: UserPrincipal = {
          kind: "user",
          id: subjectUserId,
          workspace_id: ctx.tenant.workspace_id,
          roles: [memberRow.role],
          session_id: null,
          token_id: null,
        };
        const subjectAcl = await loadDocReadResolver(ctx.db, subjectPrincipal);
        if (!subjectAcl.hasBaselineReach(docPlacementSpaceId)) {
          throw new ValidationError({
            message:
              "permission.grant: subject has no standing in the doc's Space; " +
              "a non-guest grant cannot cross the Space ceiling — use `doc.add_guest`.",
            issues: [
              {
                code: "subject_lacks_space_standing",
                message:
                  "subject_id is a workspace member without baseline reach into the " +
                  "doc's Space (no membership, no space grant, not open, not personal " +
                  "owner) — the explicit cross-Space escape hatch is doc.add_guest",
                path: ["subject_id"],
              },
            ],
          });
        }
      }
    }

    // Step 4 — upsert on the unique edge.
    const existing = await ctx.db
      .selectFrom("grants")
      .select(GRANT_ROW_COLUMNS)
      .where("resource_kind", "=", input.resource_kind)
      .where("resource_id", "=", input.resource_id)
      .where("subject_kind", "=", input.subject_kind)
      .where("subject_id", "=", input.subject_id)
      .executeTakeFirst();

    if (existing !== undefined && existing.is_guest === 1) {
      // Typed lifecycle-lane conflict (Codex guest-family SHOULD-FIX —
      // was a generic ConflictError): the caller's next verb is
      // deterministic, not a backoff-retry.
      throw new GrantLifecycleConflictError({
        message:
          "permission.grant: this edge exists as a GUEST grant; guest access is " +
          "managed via doc.add_guest / doc.remove_guest (flipping is_guest would " +
          "erase the audited escape-hatch marker).",
        existing_lane: "guest",
        grant_id: existing.id,
      });
    }

    if (existing !== undefined) {
      // Idempotent re-grant — no write; re-emit under the same id.
      if (existing.role === input.role) return toOutput(existing);

      // Role convergence — same grant_id, immutable attribution.
      const updated = await ctx.db
        .updateTable("grants")
        .set({ role: input.role })
        .where("id", "=", existing.id)
        .returning(GRANT_ROW_COLUMNS)
        .executeTakeFirst();
      if (updated === undefined) {
        // A concurrent revoke hard-deleted the edge between the SELECT
        // and this UPDATE. The caller's view is stale — re-read.
        throw new ConflictError({
          message: "permission.grant: the edge was revoked concurrently; re-read and retry.",
        });
      }
      return toOutput(updated);
    }

    const inserted = await ctx.db
      .insertInto("grants")
      .values({
        id: generateGrantId(),
        workspace_id: ctx.tenant.workspace_id,
        resource_kind: input.resource_kind,
        resource_id: input.resource_id,
        subject_kind: input.subject_kind,
        subject_id: input.subject_id,
        role: input.role,
        is_guest: 0,
        created_by,
        created_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(["workspace_id", "resource_kind", "resource_id", "subject_kind", "subject_id"])
          .doNothing(),
      )
      .returning(GRANT_ROW_COLUMNS)
      .executeTakeFirst();

    if (inserted === undefined) {
      // Unique-edge conflict fired: another writer minted this edge
      // since the step-4 SELECT (grant/add_guest race). 409 — the
      // caller re-reads and converges through the upsert branch.
      throw new ConflictError({
        message: "permission.grant: a concurrent grant created this edge; re-read and retry.",
      });
    }
    return toOutput(inserted);
  },
};
