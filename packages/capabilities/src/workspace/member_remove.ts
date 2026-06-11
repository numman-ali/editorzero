/**
 * `workspace.member_remove` — soft-delete a workspace membership row
 * (architecture.md §3.4 + Appendix A row; ADR 0024). Metadata-only
 * mutation; `workspace:admin` scope.
 *
 * **Soft-delete.** Sets `deleted_at = now` on the membership row;
 * revive-in-place happens via the future `workspace.member_add`
 * capability (ADR 0024 §5). Already-removed targets 404 — `remove`
 * is not idempotent because idempotency would swallow the signal
 * that a caller tried to remove someone who was never there or was
 * already removed by another admin.
 *
 * **Last-owner protection.** If the target is currently an `owner`
 * and is the only live `owner` row, removal throws `LastOwnerError`
 * (typed 409 with code `last_owner_protected`). Same rationale +
 * mechanics as `workspace.member_update_role`: the check runs inside
 * the write tx so COUNT + UPDATE are atomic against the target row.
 * The invariant holds in both dialects; on PG a lost SERIALIZABLE
 * race surfaces as 409 `conflict` via the global error mapper (40001
 * / 40P01 projection) rather than `last_owner_protected`. See the
 * `member_update_role` header for the full dialect-projection
 * breakdown.
 *
 * **Self-removal is allowed.** The caller can `member_remove` their
 * own user_id (voluntary leave). The last-owner guard naturally
 * blocks the dangerous case: an owner cannot leave until another
 * owner exists, preserving the "no ownerless workspace" invariant.
 *
 * **Subject.** `{kind: "user", id: target_user_id}` — the principal
 * whose membership is being revoked. Same rationale as
 * `member_update_role`: forensically richest, and `user` is in
 * SubjectKind.
 */

import type { AuditEffect, HandlerError } from "@editorzero/audit";
import { LastOwnerError, NotFoundError } from "@editorzero/errors";
import { CapabilityId, UserId } from "@editorzero/ids";
import {
  type WorkspaceMemberRemoveInput,
  WorkspaceMemberRemoveInputSchema,
  type WorkspaceMemberRemoveOutput,
  WorkspaceMemberRemoveOutputSchema,
} from "@editorzero/schemas/workspace/member_remove";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const WORKSPACE_MEMBER_REMOVE_ID = CapabilityId("workspace.member_remove");

// ── Capability ───────────────────────────────────────────────────────────

export const workspaceMemberRemove: Capability<
  WorkspaceMemberRemoveInput,
  WorkspaceMemberRemoveOutput
> = {
  id: WORKSPACE_MEMBER_REMOVE_ID,
  category: "mutation",
  summary: "Remove a member from the workspace; metadata-only, admin-only.",
  input: WorkspaceMemberRemoveInputSchema,
  output: WorkspaceMemberRemoveOutputSchema,
  requires: ["workspace:admin"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({
      kind: "user",
      id: UserId(input.user_id),
    }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "member.remove",
      workspace_id: output.workspace_id,
      user_id: output.user_id,
      deleted_at: output.deleted_at,
    }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: WORKSPACE_MEMBER_REMOVE_ID,
      required_scopes: ["workspace:admin"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) =>
      projectErrorAudit(WORKSPACE_MEMBER_REMOVE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const target_user_id = UserId(input.user_id);

    // Step 1 — existence + role check. 404 on missing or already
    // soft-deleted. `role` is needed for the last-owner branch.
    const current = await ctx.db
      .selectFrom("workspace_members")
      .select(["user_id", "role"])
      .where("user_id", "=", target_user_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (current === undefined) {
      throw new NotFoundError({
        subject_kind: "user",
        subject_id: target_user_id,
      });
    }

    // Step 2 — last-owner protection. Mirrors member_update_role:
    // inside-tx COUNT + UPDATE atomicity against concurrent demote/
    // remove. Self-removal of the last owner surfaces here — owner
    // cannot leave until another owner exists.
    if (current.role === "owner") {
      const ownerCount = await ctx.db
        .selectFrom("workspace_members")
        .where("role", "=", "owner")
        .where("deleted_at", "is", null)
        .select((eb) => eb.fn.countAll<string | number | bigint>().as("count"))
        .executeTakeFirstOrThrow();
      if (Number(ownerCount.count) <= 1) {
        throw new LastOwnerError({
          workspace_id: ctx.tenant.workspace_id,
          user_id: target_user_id,
        });
      }
    }

    // Step 3 — soft-delete. `deleted_at IS NULL` predicate is
    // defensive against a concurrent remove between step 1 and here.
    const row = await ctx.db
      .updateTable("workspace_members")
      .set({ deleted_at: now, updated_at: now })
      .where("user_id", "=", target_user_id)
      .where("deleted_at", "is", null)
      .returning(["workspace_id", "user_id", "deleted_at"])
      .executeTakeFirst();

    if (row === undefined || row.deleted_at === null) {
      throw new NotFoundError({
        subject_kind: "user",
        subject_id: target_user_id,
      });
    }

    return {
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      deleted_at: row.deleted_at,
    };
  },
};
