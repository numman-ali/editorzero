/**
 * `workspace.member_list` — paginated list of active members in the
 * caller's workspace (architecture.md §3.4; ADR 0024).
 *
 * **Scope — `workspace:admin`.** Member lists expose role topology
 * (who holds owner vs admin vs member vs guest). Today the only
 * consumer is workspace admin tooling; widening to any member is
 * deferred until there is a real user-directory surface that
 * distinguishes "who's in this workspace" (member-visible) from
 * "what role does each person hold" (admin-visible). Slice 1 keeps
 * the simpler rule.
 *
 * **Pagination — composite cursor.** `(created_at, user_id)` sort
 * with both-or-neither refine on `(before_created_at, before_user_id)`.
 * Rationale mirrors `audit.list`: `created_at` is epoch-ms so
 * collisions are possible under bursty inserts (e.g. a backfill
 * migration); a composite cursor collision-safes the page-boundary.
 * `user_id` is Better Auth-minted (not necessarily UUIDv7) so it is
 * just a secondary sort key — no monotonic-prefix assumption.
 *
 * **Active-only.** Only rows with `deleted_at IS NULL` are returned
 * in slice 1. A future `include_removed` flag can expose soft-
 * deleted rows for audit/UI "show history" flows without a breaking
 * shape change.
 *
 * **User metadata out of scope slice 1.** The output carries
 * `{user_id, role, created_at, updated_at}` only. Join on `user`
 * for `email` / `name` belongs in a future `user.get` capability
 * (or an `include_user=true` flag) — bundling here risks leaking
 * cross-workspace metadata when a user belongs to multiple
 * workspaces (doesn't exist today, but will post-multi-workspace).
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { CapabilityId, UserId } from "@editorzero/ids";
import {
  type WorkspaceMemberListInput,
  WorkspaceMemberListInputSchema,
  type WorkspaceMemberListOutput,
  WorkspaceMemberListOutputSchema,
} from "@editorzero/schemas/workspace/member_list";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const WORKSPACE_MEMBER_LIST_ID = CapabilityId("workspace.member_list");

// ── Capability ───────────────────────────────────────────────────────────

export const workspaceMemberList: Capability<WorkspaceMemberListInput, WorkspaceMemberListOutput> =
  {
    id: WORKSPACE_MEMBER_LIST_ID,
    category: "read",
    summary: "List active workspace members; paginated, admin-only.",
    input: WorkspaceMemberListInputSchema,
    output: WorkspaceMemberListOutputSchema,
    requires: ["workspace:admin"],
    surfaces: ["api", "cli", "mcp"],
    audit: {
      subjectFrom: () => ({ kind: "workspace" }),
      effectOnAllow: () => ({ kind: "audit.access_log" }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: WORKSPACE_MEMBER_LIST_ID,
        required_scopes: ["workspace:admin"],
        reason_code: reason.kind,
      }),
      effectOnError: (_input, error: HandlerError) =>
        projectErrorAudit(WORKSPACE_MEMBER_LIST_ID, error),
      collapsePolicy: {
        collapsible: true,
        window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
        // Constant bucket — same shape as audit.list. Filter-variant
        // dedup is handled by the dispatcher's input_hash path when
        // backend collapse lands (see audit-writer.ts doc-block —
        // deferred today).
        collapseKey: () => "workspace.member_list",
      },
    },
    handler: async (ctx, input) => {
      const peekLimit = input.limit + 1;

      let qb = ctx.db
        .selectFrom("workspace_members")
        .select(["user_id", "role", "created_at", "updated_at"])
        .where("deleted_at", "is", null)
        .orderBy("created_at", "desc")
        .orderBy("user_id", "desc")
        .limit(peekLimit);

      if (input.before_created_at !== undefined && input.before_user_id !== undefined) {
        // Composite-cursor predicate: strictly-lesser created_at, OR
        // equal created_at with strictly-lesser user_id. `user_id` is
        // branded at the column level; brand the cursor cast so the
        // Kysely predicate typechecks against `UserId`, not raw `string`.
        const { before_created_at } = input;
        const before_user_id = UserId(input.before_user_id);
        qb = qb.where((eb) =>
          eb.or([
            eb("created_at", "<", before_created_at),
            eb.and([eb("created_at", "=", before_created_at), eb("user_id", "<", before_user_id)]),
          ]),
        );
      }

      if (input.role !== undefined) {
        qb = qb.where("role", "=", input.role);
      }

      const rows = await qb.execute();

      const hasMore = rows.length > input.limit;
      const kept = hasMore ? rows.slice(0, input.limit) : rows;

      const members = kept.map((row) => ({
        user_id: row.user_id,
        role: row.role,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));

      const lastKept = kept[kept.length - 1];
      const next_cursor =
        hasMore && lastKept !== undefined
          ? { before_created_at: lastKept.created_at, before_user_id: lastKept.user_id }
          : null;

      return { members, next_cursor };
    },
  };
