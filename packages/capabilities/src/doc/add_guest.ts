/**
 * `doc.add_guest` — mint or converge the explicit `is_guest = 1`
 * ceiling-crossing edge on a doc (ADR 0040 Step 8, scenario 7;
 * Appendix A row; invariant 5). Metadata-only mutation;
 * `permission:grant` scope (same L1 coarse scope as `permission.grant`
 * — the REAL bound is the administer ladder below).
 *
 * **Why a separate verb.** `permission.grant` refuses two flows by
 * design: subjects without Space standing (`subject_lacks_space_standing`)
 * and subjects outside the workspace (`subject_not_workspace_member`).
 * Both route HERE — the guest edge is the one deliberately-marked
 * crossing of the Space ceiling, and keeping it a distinct verb keeps
 * the marker auditable (`is_guest = 1` is minted by exactly one
 * capability) and re-share-proof (the ceiling ignores guest grants for
 * administer/owner-tier, so a guest can never mint further guests).
 *
 * **Authority.** `assertCanAdministerDoc` over the LIVE doc — doc
 * owner-tier (creator or non-guest owner-role grant), else by
 * placement. 404-first for missing/trashed docs (trash-invisible,
 * same as `permission.grant`): sharing trash is refused without
 * confirming the doc ever existed; `doc.restore` first.
 *
 * **Deliberate asymmetries with `permission.grant`** (Codex
 * guest-family design review, 2026-06-12):
 *   - NO subject STANDING checks — that is the verb's entire point.
 *     No membership lookup, no `hasBaselineReach`. But `agent` subjects
 *     must EXIST as live agent rows in this workspace (ADR 0044
 *     Decision 3 closed the recorded existence debt for the agent kind
 *     on BOTH grant lanes — the cross-model MUST-FIX widened it from
 *     `permission.grant` alone; this does not disturb the recovery
 *     posture below, which is about the RESOURCE's placement, not the
 *     subject). `user`-subject existence stays explicitly deferred to
 *     the identity-resolution cluster — cross-workspace user ids are
 *     accepted as written, and an edge minted for a nonexistent user
 *     is inert and revocable, never reachable.
 *   - NO anomalous-placement refusal. `permission.grant`'s anomaly
 *     refusal (slice-1 MUST-FIX) exists because an `is_guest = 0` edge
 *     minted while the ceiling is unevaluable becomes an UNMARKED
 *     crossing when `space.restore` revives the binding. A guest edge
 *     carries its crossing marker by construction — mid-anomaly
 *     recovery sharing is exactly the job the MUST-FIX text reserved
 *     for this verb. Who can do it stays bounded: anomaly placement
 *     collapses `assertCanAdministerDoc` to owner-tier only.
 *
 * **Role vocabulary.** `GuestGrantRoleSchema` = `BASELINE_ACCESS_ROLES`
 * ({edit, comment, view}) — guest `owner` is unmintable: the ceiling
 * ignores guest grants for owner-tier, so the row would be a lie the
 * schema refuses to tell.
 *
 * **Upsert on the unique edge** (mirror of `permission.grant` step 4,
 * lanes swapped):
 *   1. Existing NON-guest edge — typed `GrantLifecycleConflictError`
 *      (409 `grant_lifecycle_conflict`): the subject already has
 *      standing-backed access; revoke it via `permission.revoke` first.
 *      Silently flipping 0→1 would DOWNGRADE a standing-backed edge to
 *      a ceiling-ignored one.
 *   2. Existing guest edge, same role — idempotent echo, zero writes,
 *      re-emit `acl.grant` under the same `grant_id`.
 *   3. Existing guest edge, different role — UPDATE `role` only under
 *      the same `grant_id`; attribution immutable. Zero-row return =
 *      concurrent `doc.remove_guest` deleted it → 409 `conflict`.
 *   4. Fresh INSERT `is_guest = 1` wrapped in `ON CONFLICT DO NOTHING`;
 *      zero rows = concurrent writer minted the edge → 409 `conflict`.
 *
 * **Subject.** The DOC (audit reads "what was shared"); the grantee is
 * in the `acl.grant` effect payload (`is_guest: 1` — replay reducer
 * unchanged, the kind already carries the column).
 */

import type { AuditDeny, AuditEffect, DenyReason, HandlerError } from "@editorzero/audit";
import {
  ConflictError,
  GrantLifecycleConflictError,
  NotFoundError,
  ValidationError,
} from "@editorzero/errors";
import { CapabilityId, generateGrantId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import {
  type DocAddGuestInput,
  DocAddGuestInputSchema,
  type DocAddGuestOutput,
  DocAddGuestOutputSchema,
} from "@editorzero/schemas/doc/add_guest";
import { AgentIdInputSchema } from "@editorzero/schemas/shared/ids";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_ADD_GUEST_ID = CapabilityId("doc.add_guest");

// ── Helpers (mirrors permission/grant.ts — same row, same attribution) ────

function resolveCreatedBy(principal: Principal) {
  if (principal.kind === "user") return principal.id;
  if (principal.acting_as !== undefined) return principal.acting_as;
  if (principal.owner_user_id !== null) return principal.owner_user_id;
  throw new ValidationError({
    message:
      "doc.add_guest: agent principal has neither `acting_as` nor `owner_user_id` set; " +
      "cannot attribute `grants.created_by` to a human in v1.",
    issues: [
      {
        code: "unattributable_agent",
        message:
          "workspace-owned agent principal requires a delegated `acting_as` " +
          "(agent-auth token) or a non-null `owner_user_id` for doc.add_guest",
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
  readonly id: DocAddGuestOutput["grant_id"];
  readonly workspace_id: DocAddGuestOutput["workspace_id"];
  readonly resource_kind: DocAddGuestOutput["resource_kind"];
  readonly resource_id: string;
  readonly subject_kind: DocAddGuestOutput["subject_kind"];
  readonly subject_id: string;
  readonly role: DocAddGuestOutput["role"];
  readonly is_guest: DocAddGuestOutput["is_guest"];
  readonly created_by: DocAddGuestOutput["created_by"];
  readonly created_at: number;
}

function toOutput(row: GrantRow): DocAddGuestOutput {
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

export const docAddGuest: Capability<DocAddGuestInput, DocAddGuestOutput> = {
  id: DOC_ADD_GUEST_ID,
  category: "mutation",
  summary: "Mint or converge the explicit is_guest=1 ceiling-crossing edge on a doc.",
  input: DocAddGuestInputSchema,
  output: DocAddGuestOutputSchema,
  requires: ["permission:grant"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({
      kind: "doc",
      id: input.doc_id,
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
      capability: DOC_ADD_GUEST_ID,
      required_scopes: ["permission:grant"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(DOC_ADD_GUEST_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const created_by = resolveCreatedBy(ctx.principal);

    // Step 1 — doc existence + trash posture (404 FIRST; trash-invisible).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    const doc = await ctx.db
      .selectFrom("docs")
      .select(["id", "created_by", "access_mode", "collection_id", "deleted_at"])
      .where("id", "=", input.doc_id)
      .executeTakeFirst();
    if (doc === undefined || doc.deleted_at !== null) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // Step 2 — administer authority. Deliberately NO anomaly refusal
    // and NO subject STANDING checks after this point (see header) —
    // anomaly placement still bounds WHO via the ladder (owner-tier
    // only), and the guest marker bounds WHAT the edge can ever confer.
    acl.assertCanAdministerDoc(doc);

    // Step 2b — agent-subject existence (ADR 0044 closure; the same
    // typed family as permission.grant's arm — user subjects stay
    // deferred to the identity cluster, see header). Agent ids are
    // server-minted UUIDv7s, so a non-v7 subject_id CANNOT name a live
    // row — the malformed shape folds into the same typed refusal
    // rather than letting the brand constructor throw a 500.
    if (input.subject_kind === "agent") {
      const subjectAgentId = AgentIdInputSchema.safeParse(input.subject_id);
      const agentRow = subjectAgentId.success
        ? await ctx.db
            .selectFrom("agents")
            .select(["id", "revoked_at"])
            .where("id", "=", subjectAgentId.data)
            .executeTakeFirst()
        : undefined;
      if (agentRow === undefined || agentRow.revoked_at !== null) {
        throw new ValidationError({
          message:
            "doc.add_guest: subject agent does not exist as a live agent in this " +
            "workspace; create it via agent.create (a revoked agent's id is dead — " +
            "recreate under a new id).",
          issues: [
            {
              code: "subject_agent_not_live",
              message:
                agentRow === undefined
                  ? "subject_id names no live agents row in this workspace (agent ids are server-minted UUIDv7s)"
                  : "subject agent is revoked; revocation is terminal",
              path: ["subject_id"],
            },
          ],
        });
      }
    }

    // Step 3 — upsert on the unique edge (permission.grant step 4,
    // lanes swapped: non-guest edges conflict, guest edges converge).
    const existing = await ctx.db
      .selectFrom("grants")
      .select(GRANT_ROW_COLUMNS)
      .where("resource_kind", "=", "doc")
      .where("resource_id", "=", input.doc_id)
      .where("subject_kind", "=", input.subject_kind)
      .where("subject_id", "=", input.subject_id)
      .executeTakeFirst();

    if (existing !== undefined && existing.is_guest === 0) {
      throw new GrantLifecycleConflictError({
        message:
          "doc.add_guest: this edge exists as a NON-guest grant (the subject has " +
          "standing-backed access); revoke it via permission.revoke before adding a " +
          "guest edge — flipping is_guest would silently downgrade it.",
        existing_lane: "non_guest",
        grant_id: existing.id,
      });
    }

    if (existing !== undefined) {
      // Idempotent re-add — no write; re-emit under the same id.
      if (existing.role === input.role) return toOutput(existing);

      // Role convergence — same grant_id, immutable attribution.
      const updated = await ctx.db
        .updateTable("grants")
        .set({ role: input.role })
        .where("id", "=", existing.id)
        .returning(GRANT_ROW_COLUMNS)
        .executeTakeFirst();
      if (updated === undefined) {
        // A concurrent doc.remove_guest deleted the edge between the
        // SELECT and this UPDATE. The caller's view is stale — re-read.
        throw new ConflictError({
          message: "doc.add_guest: the guest edge was removed concurrently; re-read and retry.",
        });
      }
      return toOutput(updated);
    }

    const inserted = await ctx.db
      .insertInto("grants")
      .values({
        id: generateGrantId(),
        workspace_id: ctx.tenant.workspace_id,
        resource_kind: "doc",
        resource_id: input.doc_id,
        subject_kind: input.subject_kind,
        subject_id: input.subject_id,
        role: input.role,
        is_guest: 1,
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
      // since the step-3 SELECT (grant/add_guest race). 409 — the
      // caller re-reads and converges through the upsert branch.
      throw new ConflictError({
        message: "doc.add_guest: a concurrent grant created this edge; re-read and retry.",
      });
    }
    return toOutput(inserted);
  },
};
