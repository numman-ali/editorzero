/**
 * `space.member_add` — add a member to a TEAM space (ADR 0040 Step 8;
 * Appendix A row). Metadata-only mutation; `space:manage` scope (the
 * administer ladder is the real bound).
 *
 * **Space membership IS baseline reach.** A `space_members` row is what
 * the Step-6 resolver's `baselineReach` reads, so this verb mints read
 * (and up to administer, for `role='owner'`) standing into the space.
 * That shapes every precondition below.
 *
 * **Handler order.**
 *   1. 404-first on the space — live-only SELECT (trash-invisible, the
 *      family posture). Membership of a trashed space is not editable;
 *      `space.archive` refuses while members remain, so a trashed space
 *      has an empty roster by construction anyway.
 *   2. `assertCanAdministerSpace` — space owner-tier (team: owner-role
 *      membership / non-guest owner grant / admin backstop).
 *   3. **PERSONAL spaces refuse** (`ValidationError`,
 *      `personal_space_membership_pinned`): a personal space has NO
 *      membership rows by construction — the owner's standing is the
 *      structural `owner_user_id` term in `baselineReach`, and "exactly
 *      one member: the owner" is what makes the drafts home private.
 *      Adding a member would de-facto convert it into a team space
 *      without the kind change the model requires (the
 *      `personal_space_type_pinned` reasoning, one layer up). Sharing
 *      OUT of a personal space is per-doc: `permission.grant` /
 *      `doc.add_guest`.
 *   4. **Subject standing** — the target user must hold a LIVE
 *      workspace membership (`subject_not_workspace_member`, the
 *      `permission.grant` rule): space membership is a within-Org
 *      refinement, and the future guest principal enters through
 *      doc-scoped guest grants, never a space roster.
 *   5. **Existing row → 409** `MemberAlreadyExistsError` (with
 *      `space_id` context). `space_members` is hard-DELETE, so unlike
 *      the workspace sibling there is NO revive branch — every existing
 *      row is live. Role changes flow through
 *      `space.member_update_role`.
 *   6. Fresh INSERT under `ON CONFLICT (workspace_id, space_id,
 *      user_id) DO NOTHING`; zero-row → 409 (the Branch-C race posture
 *      — the global mapper deliberately never projects raw
 *      unique-violations).
 *
 * **No auto-grant, no last-owner rule.** The row's `role` IS the
 * baseline conferral (no parallel `grants` row is minted), and a team
 * space with zero `owner`-role members stays administrable via the
 * workspace-admin backstop — so there is nothing to protect against
 * (contrast `workspace.member_remove`'s last-owner guard).
 *
 * **FK-user-missing is not pre-checked** beyond the membership rule —
 * the live `workspace_members` row already proves the user exists (it
 * FKs Better Auth's `user` table), so the `permission.grant` agents-
 * table caveat has no analogue here.
 *
 * **Subject.** `{kind: "user", id: user_id}` — the principal being
 * granted standing (the `workspace.member_add` rationale).
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { MemberAlreadyExistsError, NotFoundError, ValidationError } from "@editorzero/errors";
import { CapabilityId, SpaceId, UserId } from "@editorzero/ids";
import {
  type SpaceMemberAddInput,
  SpaceMemberAddInputSchema,
  type SpaceMemberAddOutput,
  SpaceMemberAddOutputSchema,
} from "@editorzero/schemas/space/member_add";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const SPACE_MEMBER_ADD_ID = CapabilityId("space.member_add");

export const spaceMemberAdd: Capability<SpaceMemberAddInput, SpaceMemberAddOutput> = {
  id: SPACE_MEMBER_ADD_ID,
  category: "mutation",
  summary: "Add a member to a team space; the role confers baseline reach.",
  input: SpaceMemberAddInputSchema,
  output: SpaceMemberAddOutputSchema,
  requires: ["space:manage"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "user", id: UserId(input.user_id) }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "space.member_add",
      workspace_id: output.workspace_id,
      space_id: output.space_id,
      user_id: output.user_id,
      role: output.role,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: SPACE_MEMBER_ADD_ID,
      required_scopes: ["space:manage"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(SPACE_MEMBER_ADD_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const space_id = SpaceId(input.space_id);
    const target_user_id = UserId(input.user_id);

    // Step 1 — existence + trash posture (404 FIRST, before authority).
    // `kind` rides along for the personal refusal.
    const space = await ctx.db
      .selectFrom("spaces")
      .select(["id", "kind"])
      .where("id", "=", space_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (space === undefined) {
      throw new NotFoundError({ subject_kind: "space", subject_id: input.space_id });
    }

    // Step 2 — authority (the live administer ladder).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    acl.assertCanAdministerSpace(space_id);

    // Step 3 — personal spaces hold no roster (see header). Refused
    // AFTER the authority assert so the kind is not leaked to callers
    // with no standing on the space.
    if (space.kind === "personal") {
      throw new ValidationError({
        message:
          "space.member_add: a personal space has no membership roster — " +
          "share individual docs via permission.grant or doc.add_guest.",
        issues: [
          {
            code: "personal_space_membership_pinned",
            message:
              "personal spaces hold exactly their structural owner; " + "membership is not addable",
            path: ["space_id"],
          },
        ],
      });
    }

    // Step 4 — subject standing: live workspace membership (the
    // permission.grant rule — space membership is a within-Org
    // refinement).
    const memberRow = await ctx.db
      .selectFrom("workspace_members")
      .select(["user_id"])
      .where("user_id", "=", target_user_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (memberRow === undefined) {
      throw new ValidationError({
        message:
          "space.member_add: target user is not a live workspace member; " +
          "add them via workspace.member_add first.",
        issues: [
          {
            code: "subject_not_workspace_member",
            message:
              "user_id has no live workspace membership — space membership " +
              "is a within-Org refinement",
            path: ["user_id"],
          },
        ],
      });
    }

    // Step 5 — existing row → 409. Hard-DELETE table: every row is
    // live, so no revive branch exists (contrast workspace.member_add
    // Branch B).
    const existing = await ctx.db
      .selectFrom("space_members")
      .select(["user_id"])
      .where("space_id", "=", space_id)
      .where("user_id", "=", target_user_id)
      .executeTakeFirst();
    if (existing !== undefined) {
      throw new MemberAlreadyExistsError({
        workspace_id: ctx.tenant.workspace_id,
        user_id: target_user_id,
        space_id,
      });
    }

    // Step 6 — fresh INSERT with the PK race guard (the Branch-C
    // posture: DO NOTHING catches the composite-PK conflict locally;
    // zero rows means another writer landed since step 5 — the
    // caller's roster view is stale).
    const row = await ctx.db
      .insertInto("space_members")
      .values({
        workspace_id: ctx.tenant.workspace_id,
        space_id,
        user_id: target_user_id,
        role: input.role,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(["workspace_id", "space_id", "user_id"]).doNothing())
      .returning(["workspace_id", "space_id", "user_id", "role", "created_at", "updated_at"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new MemberAlreadyExistsError({
        workspace_id: ctx.tenant.workspace_id,
        user_id: target_user_id,
        space_id,
      });
    }

    return SpaceMemberAddOutputSchema.parse(row);
  },
};
