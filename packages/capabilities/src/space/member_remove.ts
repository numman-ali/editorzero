/**
 * `space.member_remove` — hard-DELETE a space membership row (ADR 0040
 * Step 8; Appendix A row). Metadata-only mutation; `space:manage`
 * scope (the administer ladder is the real bound).
 *
 * **Hard delete, full preimage.** `space_members` carries no
 * `deleted_at` (Step-4 DDL) — removal is a `DELETE … RETURNING`, and
 * the RETURNING row is the authoritative preimage: the output echo and
 * the `space.member_remove` audit row (which carries `workspace_id` +
 * the removed `role` per the Codex Step-7 preimage rule) are the only
 * durable records of what membership existed. Re-admission is a fresh
 * `space.member_add` (new `created_at` — there is no row to revive).
 *
 * **Handler order.** 404-first on the space (live-only — membership of
 * a trashed space is not editable; `space.archive` refuses while
 * members remain, so a trashed roster is empty by construction) →
 * `assertCanAdministerSpace` → DELETE by `(space_id, user_id)` with
 * RETURNING; zero rows → 404 on the user (never on the roster — a
 * remove of someone not on it tells the caller their view is stale,
 * the `workspace.member_remove` non-idempotency rationale).
 *
 * **No last-owner protection.** A team space with zero `owner`-role
 * members stays administrable via the workspace-admin backstop (and
 * `space.archive`/`space.restore` ride the same ladder), so removing
 * the last owner-role member strands nothing — contrast the workspace
 * roster, where the backstop IS the owner set.
 *
 * **No personal-kind refusal.** A personal space has no membership
 * rows by construction, so the DELETE finds nothing → natural 404.
 * Deliberately not pre-refused on `kind`: if a corrupt row ever exists
 * on a personal space (system-handle write), remove is the REPAIR verb
 * — refusing would make the corruption permanent. Asymmetric with
 * `space.member_add`, which refuses because it would CREATE the
 * invariant violation.
 *
 * **Removal ≠ access revocation on its own.** Doc-level grants the
 * user holds (`is_guest = 0` minted while they had standing) persist —
 * the H1 lifecycle; they confer per-doc access still bounded by the
 * resolver. Removing baseline reach + every doc grant is an
 * offboarding FLOW (list + revoke), not this verb's job. The workspace
 * L1 gate (`workspace.member_remove`) stays the hard kill-switch.
 *
 * **Subject.** `{kind: "user", id: user_id}` — the principal losing
 * standing (the `workspace.member_remove` rationale).
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId, SpaceId, UserId } from "@editorzero/ids";
import {
  type SpaceMemberRemoveInput,
  SpaceMemberRemoveInputSchema,
  type SpaceMemberRemoveOutput,
  SpaceMemberRemoveOutputSchema,
} from "@editorzero/schemas/space/member_remove";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_MEMBER_REMOVE_ID = CapabilityId("space.member_remove");

export const spaceMemberRemove: Capability<SpaceMemberRemoveInput, SpaceMemberRemoveOutput> = {
  id: SPACE_MEMBER_REMOVE_ID,
  category: "mutation",
  summary: "Remove a member from a space (hard delete; the echo is the preimage).",
  input: SpaceMemberRemoveInputSchema,
  output: SpaceMemberRemoveOutputSchema,
  requires: ["space:manage"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "user", id: UserId(input.user_id) }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "space.member_remove",
      workspace_id: output.workspace_id,
      space_id: output.space_id,
      user_id: output.user_id,
      role: output.role,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: SPACE_MEMBER_REMOVE_ID,
      required_scopes: ["space:manage"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(SPACE_MEMBER_REMOVE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const space_id = SpaceId(input.space_id);
    const target_user_id = UserId(input.user_id);

    // Step 1 — existence + trash posture (404 FIRST, before authority).
    const space = await ctx.db
      .selectFrom("spaces")
      .select(["id"])
      .where("id", "=", space_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (space === undefined) {
      throw new NotFoundError({ subject_kind: "space", subject_id: input.space_id });
    }

    // Step 2 — authority (the live administer ladder).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanAdministerSpace(space_id);

    // Step 3 — hard DELETE with RETURNING as the preimage. Zero rows =
    // the target was never on this roster (or a concurrent remove won)
    // → 404 on the user.
    const row = await ctx.db
      .deleteFrom("space_members")
      .where("space_id", "=", space_id)
      .where("user_id", "=", target_user_id)
      .returning(["workspace_id", "space_id", "user_id", "role"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "user", subject_id: target_user_id });
    }

    return SpaceMemberRemoveOutputSchema.parse(row);
  },
};
