/**
 * `space.update` — patch a live space's mutable subset (ADR 0040
 * Step 8; Appendix A row). Metadata-only mutation; `space:manage`
 * scope (member-wide — the authority ladder is the real bound, the
 * `permission.grant` layering).
 *
 * **Authority.** `assertCanAdministerSpace` (acl/ceiling.ts): personal
 * → `owner_user_id` only (admins excluded — the scenario-3 privacy
 * pin); team → space owner-tier (owner-role membership / non-guest
 * owner-role space grant) ∨ workspace owner/admin backstop.
 *
 * **404 first (trash-invisible).** A missing OR soft-deleted space is
 * `not_found` before authority — editing trash is refused without
 * confirming existence; `space.restore` first.
 *
 * **The mutable subset** is exactly what the Step-7 effect carries:
 * `{name, slug, space_type, baseline_access}` — `kind` is structural,
 * `owner_user_id` is pinned by the CHECK. PERSONAL spaces additionally
 * refuse `space_type`/`baseline_access` patches: a personal space is
 * structurally private — flipping its type would de-facto convert the
 * drafts home into a shared space without the kind change the model
 * requires (typed `ValidationError`, `personal_space_type_pinned`).
 * `name`/`slug` stay patchable (cosmetic).
 *
 * **Slug change** re-runs the workspace-level live-sibling pre-check
 * (excluding self) → typed 409; `spaces_slug_unique` stays the
 * last-line race guard.
 *
 * **Effect** carries the PATCH (only the fields the caller sent) —
 * the Step-7 `space.update` shape; replay applies post-state values,
 * this capability judges the transitions.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import {
  ConflictError,
  NotFoundError,
  SlugCollisionError,
  ValidationError,
} from "@editorzero/errors";
import { CapabilityId, SpaceId } from "@editorzero/ids";
import {
  type SpaceUpdateInput,
  SpaceUpdateInputSchema,
  type SpaceUpdateOutput,
  SpaceUpdateOutputSchema,
} from "@editorzero/schemas/space/update";
import type { BaselineAccessRole, SpaceType } from "@editorzero/scopes";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_UPDATE_ID = CapabilityId("space.update");

export const spaceUpdate: Capability<SpaceUpdateInput, SpaceUpdateOutput> = {
  id: SPACE_UPDATE_ID,
  category: "mutation",
  summary: "Patch a space's name/slug/type/baseline; personal spaces pin type + baseline.",
  input: SpaceUpdateInputSchema,
  output: SpaceUpdateOutputSchema,
  requires: ["space:manage"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "space", id: input.space_id }),
    effectOnAllow: (input, _output): AuditEffect => {
      const patch: Partial<{
        name: string;
        slug: string;
        space_type: SpaceType;
        baseline_access: BaselineAccessRole;
      }> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.slug !== undefined) patch.slug = input.slug;
      if (input.space_type !== undefined) patch.space_type = input.space_type;
      if (input.baseline_access !== undefined) patch.baseline_access = input.baseline_access;
      return { kind: "space.update", space_id: input.space_id, patch };
    },
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: SPACE_UPDATE_ID,
      required_scopes: ["space:manage"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(SPACE_UPDATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const space_id = SpaceId(input.space_id);

    // Step 1 — existence + trash posture (404 FIRST, before authority).
    const space = await ctx.db
      .selectFrom("spaces")
      .select(["id", "kind", "deleted_at"])
      .where("id", "=", space_id)
      .executeTakeFirst();
    if (space === undefined || space.deleted_at !== null) {
      throw new NotFoundError({ subject_kind: "space", subject_id: input.space_id });
    }

    // Step 2 — authority (the ladder).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanAdministerSpace(space_id);

    // Step 3 — personal pins (see header).
    if (
      space.kind === "personal" &&
      (input.space_type !== undefined || input.baseline_access !== undefined)
    ) {
      throw new ValidationError({
        message:
          "space.update: a personal space's type and baseline are structurally pinned " +
          "(private, owner-only); share its docs via permission.grant / doc.move instead.",
        issues: [
          {
            code: "personal_space_type_pinned",
            message:
              "space_type/baseline_access are not patchable on a personal space — " +
              "personal is private by construction",
            path: [input.space_type !== undefined ? "space_type" : "baseline_access"],
          },
        ],
      });
    }

    // Step 4 — slug pre-check (excluding self).
    if (input.slug !== undefined) {
      const taken = await ctx.db
        .selectFrom("spaces")
        .select(["id"])
        .where("slug", "=", input.slug)
        .where("id", "!=", space_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (taken !== undefined) {
        throw new SlugCollisionError({
          slug: input.slug,
          parent_kind: "workspace",
          parent_id: null,
        });
      }
    }

    // Step 5 — apply the patch. Zero-row return = concurrent archive
    // between the SELECT and this UPDATE → 409, caller re-reads.
    const updated = await ctx.db
      .updateTable("spaces")
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.space_type !== undefined ? { type: input.space_type } : {}),
        ...(input.baseline_access !== undefined ? { baseline_access: input.baseline_access } : {}),
        updated_at: now,
      })
      .where("id", "=", space_id)
      .where("deleted_at", "is", null)
      .returning([
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
      .executeTakeFirst();
    if (updated === undefined) {
      throw new ConflictError({
        message: "space.update: the space was archived concurrently; re-read and retry.",
      });
    }

    return SpaceUpdateOutputSchema.parse({
      space_id: updated.id,
      workspace_id: updated.workspace_id,
      kind: updated.kind,
      type: updated.type,
      owner_user_id: updated.owner_user_id,
      name: updated.name,
      slug: updated.slug,
      baseline_access: updated.baseline_access,
      created_by: updated.created_by,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
      deleted_at: updated.deleted_at,
    });
  },
};
