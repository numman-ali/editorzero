/**
 * `permission.list` — enumerate the ACL edges on one doc or space
 * (ADR 0040 Step 8; Appendix A row). Read; `workspace:read` scope —
 * the resource-level visibility rule below is the real bound.
 *
 * **Visibility — administer-tier on the resource** (tightened from
 * read-tier by the Codex slice-1 review SHOULD-FIX). The full panel is
 * the sharing GRAPH — subject ids, roles, grantor attribution, guest
 * markers, timestamps — not "who is in this document":
 * `workspace.member_list` went admin-only on exactly this reasoning,
 * and it applies harder here (a cross-space guest reading one doc must
 * not harvest every internal subject and grantor on it).
 *   - doc — `assertCanAdministerDoc` (creator / non-guest owner-role
 *     doc grant / placement authority — the same ladder that bounds
 *     `permission.grant`; whoever can edit the panel can read it).
 *   - space — `assertCanAdministerSpace` (space owner-tier; workspace
 *     owner/admin backstop on team spaces; personal spaces stay
 *     owner-only against admins on the LIVE panel — the audit plane
 *     is separately see-all-by-design per the Step-8 side-channel
 *     decision).
 * Reader-level transparency ("who has access" avatars), if the product
 * wants it, is a deliberate FUTURE redacted capability (no grant ids,
 * no grantors, no markers) — never a widening of this one.
 *
 * **404 first (trash-invisible, the `doc.get` read posture).** Missing
 * OR soft-deleted resources are `not_found` before authority — a
 * trashed doc's panel is not enumerable (restore first; recorded
 * asymmetry: `permission.revoke` still works on a trashed doc's edge
 * BY ID for offboarding, the id coming from the grant echo or the
 * audit log).
 *
 * **Pagination** mirrors `workspace.member_list`: `ORDER BY created_at
 * DESC, id DESC`, peek-limit, composite `(before_created_at,
 * before_grant_id)` cursor, `next_cursor: null` on the last page.
 *
 * **Subject.** The RESOURCE whose panel is read (same pivot as
 * `permission.grant`).
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId, DocId, GrantId, SpaceId } from "@editorzero/ids";
import {
  type PermissionListInput,
  PermissionListInputSchema,
  type PermissionListOutput,
  PermissionListOutputSchema,
} from "@editorzero/schemas/permission/list";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const PERMISSION_LIST_ID = CapabilityId("permission.list");

export const permissionList: Capability<PermissionListInput, PermissionListOutput> = {
  id: PERMISSION_LIST_ID,
  category: "read",
  summary: "List the ACL edges on a doc or space; paginated, administer-gated.",
  input: PermissionListInputSchema,
  output: PermissionListOutputSchema,
  requires: ["workspace:read"],
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({
      kind: input.resource_kind,
      id: input.resource_id,
    }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: PERMISSION_LIST_ID,
      required_scopes: ["workspace:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(PERMISSION_LIST_ID, error),
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      // Constant bucket — same shape as workspace.member_list /
      // audit.list; filter-variant dedup is the dispatcher
      // input_hash path's concern when backend collapse lands.
      collapseKey: () => "permission.list",
    },
  },
  handler: async (ctx, input) => {
    // Step 1 — resource existence + trash posture (404 FIRST), then
    // the visibility rule (see header).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    if (input.resource_kind === "doc") {
      const doc = await ctx.db
        .selectFrom("docs")
        .select(["id", "created_by", "access_mode", "collection_id", "deleted_at"])
        .where("id", "=", DocId(input.resource_id))
        .executeTakeFirst();
      if (doc === undefined || doc.deleted_at !== null) {
        throw new NotFoundError({ subject_kind: "doc", subject_id: input.resource_id });
      }
      acl.assertCanAdministerDoc(doc);
    } else {
      const space_id = SpaceId(input.resource_id);
      const space = await ctx.db
        .selectFrom("spaces")
        .select(["id", "deleted_at"])
        .where("id", "=", space_id)
        .executeTakeFirst();
      if (space === undefined || space.deleted_at !== null) {
        throw new NotFoundError({ subject_kind: "space", subject_id: input.resource_id });
      }
      acl.assertCanAdministerSpace(space_id);
    }

    // Step 2 — page through the edges.
    const peekLimit = input.limit + 1;
    let qb = ctx.db
      .selectFrom("grants")
      .select([
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
      ])
      .where("resource_kind", "=", input.resource_kind)
      .where("resource_id", "=", input.resource_id)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(peekLimit);

    if (input.before_created_at !== undefined && input.before_grant_id !== undefined) {
      // Composite-cursor predicate: strictly-lesser created_at, OR
      // equal created_at with strictly-lesser id. The id column is
      // branded; brand the cursor half so the predicate typechecks.
      const { before_created_at } = input;
      const before_grant_id = GrantId(input.before_grant_id);
      qb = qb.where((eb) =>
        eb.or([
          eb("created_at", "<", before_created_at),
          eb.and([eb("created_at", "=", before_created_at), eb("id", "<", before_grant_id)]),
        ]),
      );
    }

    const rows = await qb.execute();

    const hasMore = rows.length > input.limit;
    const kept = hasMore ? rows.slice(0, input.limit) : rows;

    const grants = kept.map((row) => ({
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
    }));

    const lastKept = kept[kept.length - 1];
    const next_cursor =
      hasMore && lastKept !== undefined
        ? { before_created_at: lastKept.created_at, before_grant_id: lastKept.id }
        : null;

    return { grants, next_cursor };
  },
};
