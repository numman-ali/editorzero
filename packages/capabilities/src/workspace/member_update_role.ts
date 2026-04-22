/**
 * `workspace.member_update_role` — change a member's role
 * (architecture.md §3.4 + Appendix A row; ADR 0024). Metadata-only
 * mutation; `workspace:admin` scope.
 *
 * **404 on soft-deleted target.** If the target row is soft-deleted,
 * this is a 404 — revive-in-place semantics belong exclusively to the
 * future `workspace.member_add` capability (ADR 0024 §5). Mixing
 * revive into `update_role` would let a caller "un-delete" a member
 * by setting their role; add_member is the right verb for that.
 *
 * **Last-owner protection.** If the update would demote the last
 * `owner` row (i.e. `to_role !== "owner"` AND the target currently
 * holds the only live `owner` row), the handler throws
 * `LastOwnerError` (typed 409). The check runs inside the dispatcher
 * write-path tx (`ctx.db` is tx-bound for metadata-only capabilities),
 * so the COUNT + UPDATE pair are atomic — a concurrent admin
 * demoting the other owner cannot slip through between the check and
 * the write. A plain pre-check outside the tx would be racy.
 *
 * **No-op rejection.** If the target already has `to_role`, returning
 * a success would pollute the audit log with meaningless entries. The
 * handler SELECTs current state first (needed for `from_role` in the
 * audit payload and for the last-owner check) and 400s with
 * `validation` issue `role_unchanged` if the same role is re-asserted.
 *
 * **Subject.** `{kind: "user", id: target_user_id}` — the thing being
 * mutated. More forensically useful than `{kind: "workspace"}` (e.g.
 * "show me every role change Alice experienced").
 */

import type { AuditEffect, HandlerError } from "@editorzero/audit";
import { LastOwnerError, NotFoundError, ValidationError } from "@editorzero/errors";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import { ROLES } from "@editorzero/scopes";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const WORKSPACE_MEMBER_UPDATE_ROLE_ID = CapabilityId("workspace.member_update_role");

// ── Input ────────────────────────────────────────────────────────────────

const InputSchema = z
  .object({
    user_id: z.string().min(1, "user_id must not be empty"),
    role: z.enum(ROLES),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────

const UserIdField = z.string().transform((s): UserId => UserId(s));
const WorkspaceIdField = z.string().transform((s): WorkspaceId => WorkspaceId(s));

const OutputSchema = z.object({
  workspace_id: WorkspaceIdField,
  user_id: UserIdField,
  role: z.enum(ROLES),
  updated_at: z.number(),
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const workspaceMemberUpdateRole: Capability<Input, Output> = {
  id: WORKSPACE_MEMBER_UPDATE_ROLE_ID,
  category: "mutation",
  summary: "Change a workspace member's role; metadata-only, admin-only.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["workspace:admin"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({
      kind: "user",
      id: UserId((input as Input).user_id),
    }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "member.update_role",
      // The audit row's top-level workspace_id column already carries
      // the tenant; this field on the effect variant pins the
      // effect-local reference for offline reconstruction.
      workspace_id: output.workspace_id,
      user_id: output.user_id,
      role: output.role,
    }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: WORKSPACE_MEMBER_UPDATE_ROLE_ID,
      required_scopes: ["workspace:admin"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) =>
      projectErrorAudit(WORKSPACE_MEMBER_UPDATE_ROLE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const target_user_id = UserId(input.user_id);

    // Step 1 — fetch current membership row (for from_role, for
    // no-op rejection, and to 404 on missing/soft-deleted).
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

    if (current.role === input.role) {
      throw new ValidationError({
        message: `target already has role "${input.role}"`,
        issues: [
          {
            path: ["role"],
            code: "role_unchanged",
            message: `target already has role "${input.role}"`,
          },
        ],
      });
    }

    // Step 2 — last-owner protection. Runs inside the dispatcher's
    // write-path tx (metadata-only capabilities receive a tx-bound
    // ctx.db), so the COUNT and the subsequent UPDATE are atomic.
    // A concurrent demote of the *other* last owner cannot slip in
    // between the check and the write.
    if (current.role === "owner" && input.role !== "owner") {
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

    // Step 3 — UPDATE. The `deleted_at IS NULL` predicate is defensive
    // against a concurrent remove between step 1 and here; zero rows
    // returned → 404 (honest projection, same rationale as
    // collection.delete's closing UPDATE).
    const row = await ctx.db
      .updateTable("workspace_members")
      .set({ role: input.role, updated_at: now })
      .where("user_id", "=", target_user_id)
      .where("deleted_at", "is", null)
      .returning(["workspace_id", "user_id", "role", "updated_at"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({
        subject_kind: "user",
        subject_id: target_user_id,
      });
    }

    return {
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      role: row.role,
      updated_at: row.updated_at,
    };
  },
};
