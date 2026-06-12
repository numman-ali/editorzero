# Research memo — the user-identity-resolution cluster (facts for a future ADR)

**This is NOT an ADR.** Fact-finding banked 2026-06-12 (frontier sub-agent sweep, verified
against source) so the future ADR starts from evidence, not re-derivation. Decision forks are
*recorded*, not taken. Companion to the `docs/continuation.md` punch-list entries
(identity-resolution / space-member-list / placement-reach projection).

## Why it's a cluster, not a capability

Eleven of the fifteen `UI_PENDING` cells (member / permission / guest verbs) are blocked not
just on "resolve an id to a name" but on five interlocking gaps:

1. **No id → identity resolution anywhere.** Every blocked capability takes and echoes raw ids
   (`subject_id`, `user_id`, `created_by`); `workspace.member_list` returns
   `{user_id, role, created_at, updated_at}` — no name/email; audit rows carry
   `principal_kind` + raw `principal_id`; `whoami` is caller-only. The Web UI renders
   `user 01961a2b…` fragments today (deliberate, the audit-cell decision: exactness over
   warmth until this cluster lands).
2. **No subject picker source.** `permission.grant` / `space.member_add` validate the subject
   against live `workspace_members` rows, but a caller has no capability that *enumerates
   candidates with identities* — the picker has nothing to list.
3. **The second-user path is structurally broken under `registrationMode: "first-user"`.**
   Sign-up is hook-blocked after the first `user` row; there is no invite flow (ADR 0024 §6
   explicitly defers `workspace.invite_member`); `workspace.member_add` takes a raw `user_id`
   that therefore cannot exist → the INSERT hits the `user(id)` FK and surfaces as an
   **untyped 500** (recorded in the handler header as the FK-user-missing debt, with the two
   sketched outs: an email→user_id resolving invite slice, or a `ctx.userExists` seam).
   Under `"open"` mode a second user CAN self-register — but lands with no workspace
   membership; `member_add` is then the bridge. Any Members-screen ADR must pick the
   onboarding story first or the screen manages an empty set.
4. **No `agents` table.** Subject-existence validation is recorded debt for BOTH subject
   kinds (`permission.grant` / `doc.add_guest` headers); ADR 0040 names the agents table +
   api-key→agent resolver a prerequisite slice before an agent can *use* a grant. Agents hold
   no `workspace_members` rows (binding = `api_key.referenceId`); ADR 0024 §7 records the
   uniform-principal-listing fork (polymorphic member column vs sibling `workspace_agents`).
5. **Roster reads are missing or admin-locked.** No space-member-list capability exists at
   all (the space detail screen's roster section is blocked); `workspace.member_list` floors
   at `workspace:admin`. The per-space `placeable` reach projection (collection.move cell's
   finding) is already earmarked to "fold into the roster/identity ADR cluster".

## The auth-read seam (the load-bearing technical question)

Better Auth's `user` table is **deliberately outside the `Database` type handlers see**; the
only existing reader is `create-auth.ts`'s system handle. Columns (BA 1.6.5, no renames):
`id` (UUID, project-minted v7), `name` (NOT NULL — sign-up requires it), `email`,
`emailVerified`, `image` (nullable), `createdAt`, `updatedAt`, + project field `workspaceId`
(server-set, input-blocked). Any identity JOIN or `user.resolve` needs a **new seam** across
the auth boundary — ADR 0024/0030 territory, the fork the punch list names
(widen-`member_list`-output vs separate-`user.resolve`). The `member_list` handler header
already sketches a third shape (`user.get` or `include_user=true`) and records the
multi-workspace metadata-leak concern against naive JOINs.

## Already-decided constraints that bound the design

- **Role topology is admin-visible; "who's here" may become member-visible** — the
  `member_list` admin-floor rationale records the split explicitly ("widening to any member
  is deferred until there is a real user-directory surface that distinguishes" the two).
- **`permission.list` is administer-tier** (Codex slice-1 SHOULD-FIX): the sharing graph
  (grantors, guest markers, subject ids) must not be harvestable by a cross-space guest.
  Reader-level transparency (an avatars panel) is reserved as a deliberately **redacted
  future capability** — "never a widening of this one". An identity directory must not
  become that widening through the back door (resolve-by-id on arbitrary ids ≈ enumeration).
- **Personal-space privacy holds against admins** (0040 Step 6, proven end-to-end); identity
  display must not leak space *participation* as a side effect of resolving names.
- **Audit stays see-all-by-design at `workspace:admin`** with presentation-layer redaction as
  the only sanctioned softening — an identity-enriched audit UI is consistent with that
  (names are display sugar on ids the admin already sees).
- **Sub-floor agents**: scope tiers exist (`workspace:read` floor candidates) but the
  scopes-vs-rows asymmetry applies — a directory read needs both a scope floor AND a
  visibility rule.

## Raw-id surface inventory (what a resolver would retrofit)

| Surface | Today |
|---|---|
| `workspace.member_list` output | raw `user_id` rows, admin-only, paginated |
| `permission.grant/revoke/list`, `doc.add_guest/remove_guest` | raw `subject_id` in + out (`GrantRowOutputSchema.created_by` raw too) |
| `space.member_add/remove/update_role` | raw `user_id`; validates workspace membership exists |
| `workspace.member_add` | raw `user_id`; **no existence pre-check** (FK 500 — recorded debt) |
| audit rows + Web UI labels | `principal_kind` + raw id; `auditPrincipalLabel` renders kind + 8-char fragment |
| `whoami` | caller-only, no display fields |

## Forks the future ADR must take (recorded, untaken)

1. Widen `member_list` with identity fields vs `user.resolve(ids[])` vs `user.get`/
   `include_user` — i.e. *where* the auth-seam read lives and *who* may call it.
2. The directory split: member-visible "who's in this workspace" vs admin-visible role
   topology — two capabilities or one with projection tiers.
3. Second-user onboarding: invite capability (email-resolving, ADR 0024 §6's
   `workspace.invite_member`) vs open-registration + `member_add` bridge vs both.
4. Agents in the directory: polymorphic principal listing vs `workspace_agents` sibling
   (ADR 0024 §7), gated on the agents-table slice.
5. Space rosters: a `space.member_list` with its own visibility rule (member-visible roster
   vs admin-only; open-space baseline wrinkle), folding the `placeable` reach projection.

Cross-model validation required when the ADR is drafted (AGENTS.md — ADR-level).
