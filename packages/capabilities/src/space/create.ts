/**
 * `space.create` — mint a TEAM space (ADR 0040 Step 8; Appendix A row).
 * Metadata-only mutation; `workspace:admin` scope.
 *
 * **Authority — the L1 scope IS the bound (unlike the rest of the
 * `space.*` family).** Creation has no existing resource for the
 * authority ladder to evaluate, and creating a Space shapes the org's
 * membership topology — so it sits with the workspace owner/admin tier
 * (`workspace:admin`), not the member-wide `space:manage`. Owners and
 * admins create spaces and assign space owners via
 * `space.member_add role=owner`; those owners then run their spaces
 * under the ladder.
 *
 * **TEAM only.** `kind` is not an input: the handler pins
 * `kind = 'team'`, `owner_user_id = NULL` (the spaces CHECK ties the
 * pair). Personal spaces are signup-seeded exclusively — the
 * `(workspace_id, owner_user_id)` partial unique index enforces ≤1
 * live personal space per member, and `space.restore` (not a second
 * mint path) recovers an archived one.
 *
 * **No auto-membership.** The creator gets no `space_members` row: one
 * mutation = one audit row (invariant 3), and the admin backstop
 * already administers the fresh space. Membership is `space.member_add`,
 * explicit and separately audited.
 *
 * **Slug** derives from `name` (the `collection.create` slugify) with a
 * workspace-level live-sibling pre-check → typed 409
 * (`SlugCollisionError`); `spaces_slug_unique` remains the last-line
 * race guard. Deliberate slug changes are `space.update`'s job.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { SlugCollisionError, ValidationError } from "@editorzero/errors";
import { CapabilityId, generateSpaceId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import {
  type SpaceCreateInput,
  SpaceCreateInputSchema,
  type SpaceCreateOutput,
  SpaceCreateOutputSchema,
} from "@editorzero/schemas/space/create";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_CREATE_ID = CapabilityId("space.create");

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "untitled";
}

function resolveCreatedBy(principal: Principal) {
  if (principal.kind === "user") return principal.id;
  if (principal.acting_as !== undefined) return principal.acting_as;
  if (principal.owner_user_id !== null) return principal.owner_user_id;
  throw new ValidationError({
    message:
      "space.create: agent principal has neither `acting_as` nor `owner_user_id` set; " +
      "cannot attribute `spaces.created_by` to a human in v1.",
    issues: [
      {
        code: "unattributable_agent",
        message:
          "workspace-owned agent principal requires a delegated `acting_as` " +
          "(agent-auth token) or a non-null `owner_user_id` for space.create",
        path: ["principal"],
      },
    ],
  });
}

export const spaceCreate: Capability<SpaceCreateInput, SpaceCreateOutput> = {
  id: SPACE_CREATE_ID,
  category: "mutation",
  summary: "Create a TEAM space (membership boundary); personal spaces are signup-seeded.",
  input: SpaceCreateInputSchema,
  output: SpaceCreateOutputSchema,
  requires: ["workspace:admin"],
  agentAllowed: {},
  // "ui" landed with the Spaces screen's "+ New space" form (the
  // space.create × Web UI cell) — proven end-to-end by the marked
  // Playwright spec in packages/e2e (proves-capability-cell:
  // space.create).
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: () => ({ kind: "space" }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "space.create",
      space_id: output.space_id,
      workspace_id: output.workspace_id,
      // `kind` is the effect union's discriminant, so the row's
      // kind/type columns ride as space_kind/space_type (Step 7).
      space_kind: output.kind,
      space_type: output.type,
      owner_user_id: output.owner_user_id,
      name: output.name,
      slug: output.slug,
      baseline_access: output.baseline_access,
      created_by: output.created_by,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: SPACE_CREATE_ID,
      required_scopes: ["workspace:admin"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(SPACE_CREATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const space_id = generateSpaceId();
    const workspace_id = ctx.tenant.workspace_id;
    const now = ctx.now();
    const created_by = resolveCreatedBy(ctx.principal);
    const slug = slugify(input.name);

    // Live-sibling slug pre-check (workspace scope — spaces have no
    // parent container). Typed 409 on the common path; the partial
    // unique index re-raises an interleaved race as `internal`.
    const existing = await ctx.db
      .selectFrom("spaces")
      .select(["id"])
      .where("slug", "=", slug)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw new SlugCollisionError({ slug, parent_kind: "workspace", parent_id: null });
    }

    const row = {
      id: space_id,
      workspace_id,
      kind: "team" as const,
      type: input.space_type,
      owner_user_id: null,
      name: input.name,
      slug,
      baseline_access: input.baseline_access,
      created_by,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await ctx.db.insertInto("spaces").values(row).execute();

    return SpaceCreateOutputSchema.parse({
      space_id,
      workspace_id,
      kind: row.kind,
      type: row.type,
      owner_user_id: row.owner_user_id,
      name: row.name,
      slug: row.slug,
      baseline_access: row.baseline_access,
      created_by,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
  },
};
