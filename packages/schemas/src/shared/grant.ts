/**
 * Grant vocabulary field schemas (ADR 0040 Step 3 / ADR 0034).
 *
 * One zod enum per `@editorzero/scopes` vocabulary — the Step-8
 * capability schemas (`permission.grant`/`revoke`, `space.*`,
 * `doc.add_guest`) and the Step-5 `docs.access_mode` column schema
 * compose these rather than re-stating the literal lists, so the
 * membership has exactly one source.
 *
 * `GrantRoleSchema` is DISTINCT from any workspace-role schema: the two
 * vocabularies share the word "owner" but mean different things
 * (per-resource grant vs workspace membership). ADR 0040 names the
 * conflation a drift hazard; `packages/scopes` pins both separately.
 */

import { ACCESS_MODES, BASELINE_ACCESS_ROLES, GRANT_ROLES } from "@editorzero/scopes";
import { z } from "zod";

import { GrantIdOutputSchema, UserIdOutputSchema, WorkspaceIdOutputSchema } from "./ids";

export const GrantRoleSchema = z.enum(GRANT_ROLES);

/**
 * The role vocabulary a GUEST edge may carry: `GRANT_ROLES` minus
 * `owner` (the same value set as the space-baseline vocabulary, so the
 * one `BASELINE_ACCESS_ROLES` array sources both — no third list to
 * drift). A guest owner-role edge would be a lying row: the ceiling
 * deliberately ignores guest grants for administer/owner-tier
 * (re-share-proof by design, ADR 0040 scenario 7), so the schema
 * refuses to mint the label rather than letting surfaces explain a
 * fake owner.
 */
export const GuestGrantRoleSchema = z.enum(BASELINE_ACCESS_ROLES);

export const AccessModeSchema = z.enum(ACCESS_MODES);

/**
 * The `grants` polymorphic enums (ADR 0040 fork #3, H12 — flat fields,
 * no nested PrincipalRef). Mirrors `GrantsTable`'s column unions; v1
 * values, open for greenfield WIDENING only (`collection` resource and
 * `team` subject are reserved).
 */
export const GrantResourceKindSchema = z.enum(["space", "doc"]);

export const GrantSubjectKindSchema = z.enum(["user", "agent"]);

/**
 * One grant row on the wire — the shared OUTPUT shape for the whole
 * `permission.*` family (ADR 0034 SSOT: `permission.grant` echoes the
 * upserted row, `permission.revoke` echoes the deleted row's full
 * preimage, `permission.list` items reuse it). Field-for-field this is
 * `GrantsTable` with the `id → grant_id` output-naming convention.
 *
 * `resource_id` / `subject_id` stay plain strings: both columns are
 * polymorphic (doc-or-space, user-or-agent), so there is no single
 * brand to narrow to — handlers brand per `*_kind` where they need to.
 * `is_guest` is `0 | 1` because the LIST surface returns guest edges
 * too; `permission.grant`/`revoke` only ever touch non-guest edges
 * (guest lifecycles belong to `doc.add_guest` / `doc.remove_guest`)
 * — that tighter fact is a handler invariant pinned by their tests,
 * not a separate wire shape to drift.
 */
export const GrantRowOutputSchema = z.object({
  grant_id: GrantIdOutputSchema,
  workspace_id: WorkspaceIdOutputSchema,
  resource_kind: GrantResourceKindSchema,
  resource_id: z.string(),
  subject_kind: GrantSubjectKindSchema,
  subject_id: z.string(),
  role: GrantRoleSchema,
  is_guest: z.union([z.literal(0), z.literal(1)]),
  created_by: UserIdOutputSchema,
  created_at: z.number(),
});
