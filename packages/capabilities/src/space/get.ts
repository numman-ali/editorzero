/**
 * `space.get` — read a single space's row (ADR 0040 Step 8; the first
 * Space-scoped read). Read; `workspace:read` scope — the visibility
 * rule below is the real bound.
 *
 * **Visibility — reach ∨ administer.** A space is visible to whoever
 * the resolver gives baseline reach (membership at any role / a space
 * grant / the open-space Org-member baseline, user subjects only / the
 * personal-space owner) OR administer standing (which adds the
 * workspace owner/admin backstop on team spaces). The administer term
 * is deliberate honesty, not a widening: an admin can already
 * `space.member_add` themselves into any team space — hiding the row
 * while granting the verb would be theater. Personal spaces stay
 * owner-only (both terms resolve to the structural owner; admins are
 * denied — the privacy pin every personal verb carries). Agents see
 * only what they're granted (no Org baseline); delegated agents see
 * through their delegator (H8 — the resolver's subject IS the
 * delegator).
 *
 * **Open vs closed vs private (recorded for the read family).** In v1
 * enforcement `closed` and `private` are identical — neither confers
 * implicit reach; membership/grant/administer are the only doors. The
 * distinction is RESERVED for future join-request flows (`closed` =
 * discoverable, ask to join; `private` = invisible until invited).
 * This capability does not pre-implement discoverability: a closed
 * space a member cannot reach is acl-denied here exactly like a
 * private one.
 *
 * **404 first (trash-invisible, the `doc.get` read posture).** Missing
 * OR soft-deleted → `not_found` before the visibility check. Trash
 * browse/restore discovery is a future trash-family capability, not a
 * widening of the live read.
 *
 * **Output.** `SpaceRowOutputSchema` verbatim — the ONE space row
 * shape every `space.*` verb echoes (`deleted_at` structurally null
 * here).
 */

import type { HandlerError } from "@editorzero/audit";
import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { NotFoundError, PermissionDeniedError } from "@editorzero/errors";
import { CapabilityId, SpaceId } from "@editorzero/ids";
import {
  type SpaceGetInput,
  SpaceGetInputSchema,
  type SpaceGetOutput,
  SpaceGetOutputSchema,
} from "@editorzero/schemas/space/get";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_GET_ID = CapabilityId("space.get");

export const spaceGet: Capability<SpaceGetInput, SpaceGetOutput> = {
  id: SPACE_GET_ID,
  category: "read",
  summary: "Read a single space's row; visible to baseline reach or administer standing.",
  input: SpaceGetInputSchema,
  output: SpaceGetOutputSchema,
  requires: ["workspace:read"],
  // "ui" landed with the /space/$spaceId detail screen (the space.get ×
  // Web UI cell) — proven end-to-end by the marked Playwright spec in
  // packages/e2e (proves-capability-cell: space.get).
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "space", id: SpaceId(input.space_id) }),
    effectOnAllow: () => ({ kind: "audit.access_log" }),
    effectOnDeny: (_input, reason) => ({
      kind: "deny",
      capability: SPACE_GET_ID,
      required_scopes: ["workspace:read"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(SPACE_GET_ID, error),
    // Reads collapse per §9.3, one bucket per space (the doc.get
    // shape). `collapseKey` receives `unknown` (the type lives in
    // `@editorzero/audit` and cannot see `I`); re-parse the
    // dispatcher-validated input instead of casting.
    collapsePolicy: {
      collapsible: true,
      window_ms: AUDIT_READ_COLLAPSE_WINDOW_MS,
      collapseKey: (input) => `space.get:${SpaceGetInputSchema.parse(input).space_id}`,
    },
  },
  handler: async (ctx, input) => {
    const space_id = SpaceId(input.space_id);

    // Step 1 — existence + trash posture (404 FIRST, before the
    // visibility check — trash-invisible read posture).
    const row = await ctx.db
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
      .where("id", "=", space_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "space", subject_id: input.space_id });
    }

    // Step 2 — visibility: reach ∨ administer (see header).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    if (!acl.hasBaselineReach(space_id) && !acl.canAdministerSpace(space_id)) {
      throw new PermissionDeniedError({
        reason: { kind: "acl_deny", scope: { space_id } },
      });
    }

    return SpaceGetOutputSchema.parse({
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
    });
  },
};
