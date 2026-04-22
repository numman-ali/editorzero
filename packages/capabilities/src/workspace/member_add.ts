/**
 * `workspace.member_add` — add or revive-in-place a workspace
 * membership row (architecture.md §3.4 + Appendix A row; ADR 0024 §5).
 * Metadata-only mutation; `workspace:admin` scope.
 *
 * **Three branches.** The caller provides `{user_id, role}`; the
 * handler SELECTs the existing membership row (regardless of
 * `deleted_at`) and dispatches:
 *   1. **Live row** (`deleted_at IS NULL`) — throws
 *      `MemberAlreadyExistsError` (typed 409 with code
 *      `member_already_exists`). Not 200: add is the "grant
 *      membership" verb, and silently succeeding when the target is
 *      already a member loses the signal that the caller's view of
 *      the roster is stale. Role changes flow through
 *      `workspace.member_update_role`.
 *   2. **Soft-deleted row** (`deleted_at IS NOT NULL`) — revive-in-
 *      place: UPDATE clearing `deleted_at`, setting `role` (may
 *      differ from the pre-delete role), bumping `updated_at`.
 *      Preserves the original `created_at`. Rationale per ADR 0024
 *      §5: composite PK `(workspace_id, user_id)` means an INSERT
 *      would collide; the UPDATE is the only correct restoration
 *      path. Role is taken from the request because the re-admit
 *      decision carries fresh role intent ("re-add Alice, as admin
 *      this time").
 *   3. **No row** — fresh INSERT with `created_at = updated_at = now`,
 *      `deleted_at = null`, wrapped in `ON CONFLICT (workspace_id,
 *      user_id) DO NOTHING RETURNING ...`. `workspace_id` is forced
 *      by the tenant-scoping plugin (the Kysely `ctx.db` handle is
 *      tenant-bound). The ON CONFLICT clause is a local race guard
 *      — a plain INSERT would surface a raw `23505` (PG
 *      unique_violation) as an untyped 500 when two admins both
 *      pass Branch A's SELECT and race the INSERT; the global error
 *      mapper intentionally does *not* project 23505 (pinned in
 *      `app.unit.test.ts`), because teaching it that duplicate-key
 *      is generically safe would hide real data-integrity bugs
 *      elsewhere. Zero-row return from the ON CONFLICT path re-throws
 *      `MemberAlreadyExistsError`; caller re-reads to decide.
 *
 * **FK-user-missing is not pre-checked in slice 1.** The DDL has
 * `user_id REFERENCES user(id)`; if the request carries a `user_id`
 * that does not exist in Better Auth's `user` table, the INSERT hits a
 * FK violation and surfaces as an untyped error through the global
 * mapper. The `user` table is BA-owned and outside the `Database`
 * type exposed to handlers; a pre-check would need a new seam.
 *
 * This is acceptable for slice 1 because the user-resolution UX is an
 * unshipped future concern (email lookup / invite flow / user-directory
 * surface). When that slice lands, it resolves (email | handle) →
 * user_id *before* calling `member_add`, and either (a) adds a
 * handler-level seam (`ctx.userExists(user_id)`) for the defence-in-
 * depth 404, or (b) folds invite + add into a single capability
 * (`workspace.invite_member`) per ADR 0024 §6. The current path's
 * behaviour is "add_member works against a valid user_id" — out-of-
 * band user resolution is the caller's responsibility.
 *
 * **Last-owner protection is not relevant here.** `member_add` grows
 * the membership set; it cannot reduce the live-owner count. The
 * last-owner invariant is enforced on `member_remove` +
 * `member_update_role` only.
 *
 * **Subject.** `{kind: "user", id: target_user_id}` — the principal
 * being granted membership. Same rationale as `member_remove` /
 * `member_update_role`: forensically richest, `user` is in
 * `SubjectKind`.
 */

import type { AuditEffect, HandlerError } from "@editorzero/audit";
import { MemberAlreadyExistsError } from "@editorzero/errors";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import { ROLES } from "@editorzero/scopes";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const WORKSPACE_MEMBER_ADD_ID = CapabilityId("workspace.member_add");

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
  created_at: z.number(),
  updated_at: z.number(),
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const workspaceMemberAdd: Capability<Input, Output> = {
  id: WORKSPACE_MEMBER_ADD_ID,
  category: "mutation",
  summary: "Add or revive a workspace member; metadata-only, admin-only.",
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
      kind: "member.add",
      workspace_id: output.workspace_id,
      user_id: output.user_id,
      role: output.role,
    }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: WORKSPACE_MEMBER_ADD_ID,
      required_scopes: ["workspace:admin"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) =>
      projectErrorAudit(WORKSPACE_MEMBER_ADD_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const target_user_id = UserId(input.user_id);

    // Step 1 — SELECT including soft-deleted rows. The tenant-scoping
    // plugin injects `workspace_id`; we don't filter on `deleted_at`
    // because the revive-in-place branch (ADR 0024 §5) needs to see
    // soft-deleted rows.
    const existing = await ctx.db
      .selectFrom("workspace_members")
      .select(["user_id", "role", "created_at", "deleted_at"])
      .where("user_id", "=", target_user_id)
      .executeTakeFirst();

    // Branch A — live member already → 409.
    if (existing !== undefined && existing.deleted_at === null) {
      throw new MemberAlreadyExistsError({
        workspace_id: ctx.tenant.workspace_id,
        user_id: target_user_id,
      });
    }

    // Branch B — soft-deleted row → revive. `deleted_at IS NOT NULL`
    // predicate defends against a concurrent revive between step 1
    // and this UPDATE (zero rows returned → 409 conflict via global
    // mapper, or the other revive has already landed whichever state
    // is the single source of truth).
    if (existing !== undefined && existing.deleted_at !== null) {
      const row = await ctx.db
        .updateTable("workspace_members")
        .set({ role: input.role, deleted_at: null, updated_at: now })
        .where("user_id", "=", target_user_id)
        .where("deleted_at", "is not", null)
        .returning(["workspace_id", "user_id", "role", "created_at", "updated_at"])
        .executeTakeFirst();

      if (row === undefined) {
        // Concurrent revive lost the race — another admin already
        // revived this row. Surface as 409 so the caller can re-read
        // and decide what to do next.
        throw new MemberAlreadyExistsError({
          workspace_id: ctx.tenant.workspace_id,
          user_id: target_user_id,
        });
      }

      return {
        workspace_id: row.workspace_id,
        user_id: row.user_id,
        role: row.role,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }

    // Branch C — fresh INSERT. Uses `ON CONFLICT (workspace_id,
    // user_id) DO NOTHING` because a plain INSERT has a PG race the
    // route contract does not admit: two admins both pass Branch A's
    // step-1 SELECT, one commits an INSERT, the other hits a raw
    // `23505` (unique_violation on the composite PK) that the global
    // error mapper intentionally does *not* project (see
    // `app.unit.test.ts` — 23505 is pinned as NOT mapped, because
    // teaching the mapper that duplicate-key is generically "safe"
    // would hide real data integrity bugs elsewhere). DO NOTHING
    // catches the PK conflict locally; zero-row return means another
    // writer landed a row since our step-1 SELECT, so we throw
    // `MemberAlreadyExistsError` — the caller's view of the roster
    // is stale, re-read and decide. `workspace_id` is auto-injected
    // by the tenant-scoping plugin; we pass it explicitly for type-
    // checking against the Kysely `InsertObject` shape.
    const row = await ctx.db
      .insertInto("workspace_members")
      .values({
        workspace_id: ctx.tenant.workspace_id,
        user_id: target_user_id,
        role: input.role,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .onConflict((oc) => oc.columns(["workspace_id", "user_id"]).doNothing())
      .returning(["workspace_id", "user_id", "role", "created_at", "updated_at"])
      .executeTakeFirst();

    if (row === undefined) {
      // PK conflict fired → another writer (fresh add or revive)
      // landed a row on `(workspace_id, user_id)` since step 1.
      // The edge where the racing write is a soft-delete landing
      // between step 1 and here requires add + remove inside the
      // same tx-race window — vanishingly rare under normal flow.
      // `MemberAlreadyExistsError` is the right projection either
      // way: the caller tried to add someone who is (or just was)
      // on the roster under a PK they thought was free.
      throw new MemberAlreadyExistsError({
        workspace_id: ctx.tenant.workspace_id,
        user_id: target_user_id,
      });
    }

    return {
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      role: row.role,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  },
};
