/**
 * `space.restore` — revive a soft-deleted space (ADR 0040 invariant-6
 * bullet; the 1:1 inverse of `space.archive`; Appendix A row).
 * Metadata-only mutation; `space:manage` scope.
 *
 * **Authority on a DEAD row.** `canAdministerSpace` structurally fails
 * closed on soft-deleted spaces (slice 1 deliberately refused to
 * bypass it for revoke) — restore is the ONE verb whose authority must
 * evaluate on the trashed row, so it uses the intent-named
 * `assertCanRestoreSpace`: the same ladder body minus the liveness
 * gate. Personal → `owner_user_id`; team → non-guest owner-role space
 * grant (grants RIDE through archive — H1, state-as-of-delete) ∨ the
 * workspace owner/admin backstop (owner-role membership normally
 * cannot exist here — a compliant archive refused while members
 * remained).
 *
 * **Preconditions (typed 409s), in order:**
 *  1. Slug — another LIVE space claimed the slug while this one was
 *     trashed → `SlugCollisionError`; rename the live holder (or
 *     archive it) first. The partial unique index would otherwise fire
 *     mid-UPDATE as an untyped 500.
 *  2. Personal uniqueness — restoring a personal space when its owner
 *     somehow has ANOTHER live one would violate
 *     `spaces_personal_unique`. Unreachable today (signup is the only
 *     mint path and runs once), but the future member-invitation
 *     seeding obligation makes this state constructible — pre-check →
 *     `ConflictError` rather than a raw index violation.
 *
 * The workspace-liveness "parent path" analogue is vacuous: a space's
 * only ancestor is the workspace, and requests into a deleted
 * workspace never reach a handler.
 *
 * **Missing or already-live → 404** (the `collection.restore`
 * posture: restore acts on trash only; "restoring" a live space would
 * be a no-op lie).
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { ConflictError, NotFoundError, SlugCollisionError } from "@editorzero/errors";
import { CapabilityId, SpaceId } from "@editorzero/ids";
import {
  type SpaceRestoreInput,
  SpaceRestoreInputSchema,
  type SpaceRestoreOutput,
  SpaceRestoreOutputSchema,
} from "@editorzero/schemas/space/restore";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_RESTORE_ID = CapabilityId("space.restore");

export const spaceRestore: Capability<SpaceRestoreInput, SpaceRestoreOutput> = {
  id: SPACE_RESTORE_ID,
  category: "mutation",
  summary:
    "Restore a soft-deleted space; refuses on a live slug collision or a second live personal space.",
  input: SpaceRestoreInputSchema,
  output: SpaceRestoreOutputSchema,
  requires: ["space:manage"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "space", id: input.space_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "space.restore",
      space_id: output.space_id,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: SPACE_RESTORE_ID,
      required_scopes: ["space:manage"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(SPACE_RESTORE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const space_id = SpaceId(input.space_id);

    // Step 1 — fetch the TRASHED row (missing or live → 404). The
    // SELECT carries kind/owner/slug for the precondition checks.
    const current = await ctx.db
      .selectFrom("spaces")
      .select(["id", "kind", "owner_user_id", "slug"])
      .where("id", "=", space_id)
      .where("deleted_at", "is not", null)
      .executeTakeFirst();
    if (current === undefined) {
      throw new NotFoundError({ subject_kind: "space", subject_id: input.space_id });
    }

    // Step 2 — authority on the dead row (see header).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanRestoreSpace(space_id);

    // Step 3 — slug precondition: a LIVE space claimed it meanwhile.
    const slugTaken = await ctx.db
      .selectFrom("spaces")
      .select(["id"])
      .where("slug", "=", current.slug)
      .where("id", "!=", space_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (slugTaken !== undefined) {
      throw new SlugCollisionError({
        slug: current.slug,
        parent_kind: "workspace",
        parent_id: null,
      });
    }

    // Step 4 — personal-uniqueness precondition (see header).
    if (current.kind === "personal" && current.owner_user_id !== null) {
      const liveTwin = await ctx.db
        .selectFrom("spaces")
        .select(["id"])
        .where("kind", "=", "personal")
        .where("owner_user_id", "=", current.owner_user_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (liveTwin !== undefined) {
        throw new ConflictError({
          message:
            "space.restore: the owner already has a live personal space; archive it first " +
            "(at most one live personal space per member).",
        });
      }
    }

    // Step 5 — restore. The trashed guard defends against a concurrent
    // restore between step 1 and here; zero rows → 404 (the
    // collection.restore posture).
    const row = await ctx.db
      .updateTable("spaces")
      .set({ deleted_at: null, updated_at: now })
      .where("id", "=", space_id)
      .where("deleted_at", "is not", null)
      .returning(["id"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "space", subject_id: input.space_id });
    }

    return SpaceRestoreOutputSchema.parse({ space_id: row.id });
  },
};
