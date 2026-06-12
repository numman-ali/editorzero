/**
 * `space.list` — enumerate the spaces visible to the caller (ADR 0040
 * Step 8). Read; `workspace:read` scope — the per-row visibility rule
 * is the real bound.
 *
 * **Visibility — reach ∨ administer, per row** (the `space.get` rule;
 * see that header for the full rationale incl. the admin-honesty term
 * and the closed-vs-private reservation). Concretely: a plain member
 * sees every open space, plus the closed/private spaces they belong to
 * or hold a space grant on, plus their own personal space; a workspace
 * owner/admin additionally sees every team space (administer
 * backstop) but NOT other members' personal spaces; a non-delegated
 * agent sees only spaces it holds grants on; a delegated agent sees
 * its delegator's view (H8).
 *
 * **Unpaginated, deliberately** (schema header has the wire-side
 * note): spaces are org structure — tens, not thousands — and the
 * visibility filter is a resolver predicate, not SQL, so the
 * `doc.list` full-scan-then-filter shape fits and a cursor would page
 * over invisible rows. Revisit additively if scale demands.
 *
 * **Ordering.** `name ASC, id ASC` — presentation-natural for the
 * Spaces grid / CLI table and deterministic under duplicate names
 * (slugs are unique; names are not).
 *
 * **Trash-invisible.** Live rows only (`deleted_at IS NULL`) — the
 * read posture everywhere; trash browse is a future trash-family
 * capability.
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { CapabilityId } from "@editorzero/ids";
import {
  type SpaceListInput,
  SpaceListInputSchema,
  type SpaceListOutput,
  SpaceListOutputSchema,
} from "@editorzero/schemas/space/list";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_LIST_ID = CapabilityId("space.list");

export const spaceList: Capability<SpaceListInput, SpaceListOutput> = {
  id: SPACE_LIST_ID,
  category: "read",
  summary: "List the spaces visible to the caller (reach or administer standing, per row).",
  input: SpaceListInputSchema,
  output: SpaceListOutputSchema,
  requires: ["workspace:read"],
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: () => ({ kind: "workspace" }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: SPACE_LIST_ID,
      required_scopes: ["workspace:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(SPACE_LIST_ID, error),
    // Constant bucket — `space.list` has no input, so identical calls
    // within the window always collapse (the doc.list shape).
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      collapseKey: () => "space.list",
    },
  },
  handler: async (ctx) => {
    const rows = await ctx.db
      .selectFrom("spaces")
      .select([
        "id",
        "workspace_id",
        "kind",
        "type",
        "owner_user_id",
        "name",
        "slug",
        "baseline_access",
        "created_by",
        "created_at",
        "updated_at",
        "deleted_at",
      ])
      .where("deleted_at", "is", null)
      .orderBy("name", "asc")
      .orderBy("id", "asc")
      .execute();

    // Per-row visibility: reach ∨ administer (see header).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    const visible = rows.filter(
      (row) => acl.hasBaselineReach(row.id) || acl.canAdministerSpace(row.id),
    );

    return SpaceListOutputSchema.parse({
      spaces: visible.map((row) => ({
        space_id: row.id,
        workspace_id: row.workspace_id,
        kind: row.kind,
        type: row.type,
        owner_user_id: row.owner_user_id,
        name: row.name,
        slug: row.slug,
        baseline_access: row.baseline_access,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at,
      })),
    });
  },
};
