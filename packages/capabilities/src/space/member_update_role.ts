/**
 * `space.member_update_role` — change a space member's role (ADR 0040
 * Step 8; Appendix A row). Metadata-only mutation; `space:manage`
 * scope (the administer ladder is the real bound).
 *
 * Mirrors `workspace.member_update_role` keyed by `(space_id,
 * user_id)` over the `GRANT_ROLES` vocabulary, minus the last-owner
 * guard (the workspace-admin backstop administers a team space with
 * zero owner-role members — see `space.member_remove`'s header) and
 * minus the soft-delete branch (`space_members` is hard-DELETE; every
 * row is live).
 *
 * **No-op rejection.** Re-asserting the current role 400s
 * (`role_unchanged`, the workspace sibling's posture) — a success
 * would mint a meaningless audit row.
 *
 * **Handler order.** 404-first on the space (live-only) →
 * `assertCanAdministerSpace` → SELECT the membership row (404 missing)
 * → `role_unchanged` rejection → UPDATE with RETURNING. The UPDATE
 * re-predicates on the CURRENT role so a concurrent role change
 * between SELECT and UPDATE zero-rows → 409 `ConflictError` (the
 * caller's roster view went stale mid-flight) rather than silently
 * clobbering the other writer.
 *
 * **Subject.** `{kind: "user", id: user_id}` — the principal whose
 * standing changes (the `workspace.member_update_role` rationale:
 * "show me every role change Alice experienced").
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { ConflictError, NotFoundError, ValidationError } from "@editorzero/errors";
import { CapabilityId, SpaceId, UserId } from "@editorzero/ids";
import {
  type SpaceMemberUpdateRoleInput,
  SpaceMemberUpdateRoleInputSchema,
  type SpaceMemberUpdateRoleOutput,
  SpaceMemberUpdateRoleOutputSchema,
} from "@editorzero/schemas/space/member_update_role";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_MEMBER_UPDATE_ROLE_ID = CapabilityId("space.member_update_role");

export const spaceMemberUpdateRole: Capability<
  SpaceMemberUpdateRoleInput,
  SpaceMemberUpdateRoleOutput
> = {
  id: SPACE_MEMBER_UPDATE_ROLE_ID,
  category: "mutation",
  summary: "Change a space member's role (baseline reach tier).",
  input: SpaceMemberUpdateRoleInputSchema,
  output: SpaceMemberUpdateRoleOutputSchema,
  requires: ["space:manage"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "user", id: UserId(input.user_id) }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "space.member_update_role",
      space_id: output.space_id,
      user_id: output.user_id,
      role: output.role,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: SPACE_MEMBER_UPDATE_ROLE_ID,
      required_scopes: ["space:manage"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(SPACE_MEMBER_UPDATE_ROLE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
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

    // Step 3 — current row (404 missing; role for the no-op rejection
    // and the optimistic UPDATE predicate).
    const current = await ctx.db
      .selectFrom("space_members")
      .select(["role"])
      .where("space_id", "=", space_id)
      .where("user_id", "=", target_user_id)
      .executeTakeFirst();
    if (current === undefined) {
      throw new NotFoundError({ subject_kind: "user", subject_id: target_user_id });
    }

    // Step 4 — no-op rejection (the workspace sibling's posture).
    if (current.role === input.role) {
      throw new ValidationError({
        message: "space.member_update_role: member already holds that role.",
        issues: [
          {
            code: "role_unchanged",
            message: `member already has role '${input.role}'`,
            path: ["role"],
          },
        ],
      });
    }

    // Step 5 — UPDATE re-predicated on the role read in step 3; a
    // concurrent role change zero-rows here → 409 (stale roster view),
    // never a silent clobber.
    const row = await ctx.db
      .updateTable("space_members")
      .set({ role: input.role, updated_at: now })
      .where("space_id", "=", space_id)
      .where("user_id", "=", target_user_id)
      .where("role", "=", current.role)
      .returning(["workspace_id", "space_id", "user_id", "role", "updated_at"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new ConflictError({
        message:
          "space.member_update_role: the member's role changed concurrently — re-read the roster",
      });
    }

    return SpaceMemberUpdateRoleOutputSchema.parse(row);
  },
};
