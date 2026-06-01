# ADR 0024 — Workspace membership shape: custom `workspace_members` table; Better Auth for credentials only

**Status:** Accepted (landed 2026-04-20; member CRUD 2026-04-22)
**Date:** 2026-04-20
**Deciders:** @numman

> **Extended by [ADR 0040](0040-tenancy-ia-model.md) (2026-06-01).** ADR 0040 cashes out this ADR's reserved evolution axes (orgs-above-workspaces, teams-within-workspaces) as the **Org → Space → Collection/Doc** tenancy model. It does **not** supersede this ADR: `workspaces` stays the physical tenant root and `workspace_id` stays the scope column; **Space** is a new table *within* the workspace (no rename). v1 builds Space + Personal + per-doc `grants` + agents-as-grant-targets; Teams, the multi-org `organizations` table, and the guest-principal stay reserved here.

## Context

`resolver.ts:74` hardcodes `roles: ["member"]` for every authenticated
session because there is no table to query for the actual role. The
consequence is that four of the seven shipped doc capabilities
(`publish`, `unpublish`, `delete`, `restore`) are structurally
unreachable under real auth — they require `doc:publish` or
`doc:delete` scope, which `ROLE_SCOPES.member` (`gate.ts:96–107`)
doesn't carry. AGENTS.md invariant 6 (soft-deletes recoverable via a
first-class capability) is type-reachable but not human-reachable.

The fix is a membership table that sources the principal's role. The
ADR exists because the *shape* of that table is a load-bearing
decision — it interacts with Better Auth's own access-control
surfaces (organization / admin / api-key / access-control DSL
plugins), with ADR 0016's agent-peer-principal model (agents are
**not** BA users — they can't sit in BA's `member` table), with ADR
0017's soft-delete cascade (membership rows need `deleted_at`), with
architecture §3.4's canonical sketch, and with orgs-above-workspaces
/ teams-within-workspaces evolution the user flagged as plausible
future product direction that we shouldn't lock out.

Two independent research paths ran (Codex peer review + Opus
sub-agent reading BA's docs end-to-end from
https://better-auth.com/llms.txt). They converged on rejecting the
full-BA-plugin pivot. They differed on whether to adopt BA's
`member` table as a shared data store without adopting its plugin
APIs — Codex rejected that intermediate shape; the sub-agent argued
for it on "free invite flow" grounds but conceded in its closing
paragraph that MVP reduces to the custom-table shape anyway. This
ADR settles which abstraction owns the membership record.

## Options considered

### A. Full Better Auth Organization plugin adoption

BA's `organization` plugin ships `organization` + `member` +
`invitation` (+ optional `team` / `teamMember` / `organizationRole`)
tables, full membership-management APIs, `activeOrganizationId` /
`activeTeamId` session state, an invite flow, a
`createAccessControl` + `newRole` typed-permissions DSL, and
organization-lifecycle hooks. `member.role` is stored as a
**comma-separated multi-role string**.

**Pros.** Invite state machine, membership CRUD, client-side hooks
(`authClient.organization.inviteMember`, `setActive`) all
ready-made. Teams sub-plugin exists for future "teams within a
workspace" product direction.

**Cons.**
- `organization` becomes the product primitive; our stack
  (`UserPrincipal.workspace_id`, tenant-scoped DB,
  `AccessPath.workspace_id`, agents-per-workspace) uses `workspace`
  as the primitive everywhere. Double-speak in every capability
  doc-block and resolver.
- `member.role` is comma-separated-multi-role. Our design is singular
  role per row (architecture §3.4). Adopting BA's shape means either
  living with CSV parsing or customizing the schema.
- `member` has **no `deleted_at`**. ADR 0017's soft-delete cascade
  applies to membership; we'd need `schema.member.additionalFields`
  to add it.
- `activeOrganizationId` session state is a different workspace
  model from ours — we resolve workspace per request from the
  principal's token / context, not from sticky session state. The
  two would fight in the custom-domain / tenant-resolution slice.
- BA tables are `camelCase` (`organizationId`, `userId`,
  `createdAt`). Our schema is `snake_case` (architecture §3.1). Any
  join site has to reconcile.
- `createAccessControl` + `hasPermission` is a plugin-local
  permissions DSL. It answers "does role R have action A on
  resource X in this org?" Our gate answers "is `capability.requires
  ⊆ principal.scopes`?" These are parallel systems at different
  levels; BA's doesn't replace `ROLE_SCOPES` or the dispatcher
  gate.
- **Agents can't be org members.** `member.userId` FKs to BA's
  `user` table. Agents aren't BA users (ADR 0016). We'd have two
  membership paths anyway (BA-owned for humans, ours for agents),
  killing the "single source" benefit.
- Schema coupling — a BA org plugin major-version schema change
  breaks our authz path.

Rejected. This is a control-plane decision, not a tactical slice.
If it's ever taken, the ADR (not this one) that codifies it is
proportional to the blast radius.

### B. BA organization plugin tables for membership; our dispatcher gate for scope-checking

Adopt the org plugin, use BA's `member` table as the role source,
but query it directly from our resolver (not via
`auth.api.getActiveMember`). Keep `PermissionGate` / `ROLE_SCOPES` /
`capability.requires` entirely ours.

**Pros.** Potentially inherits BA's invite flow, lifecycle hooks,
and client APIs without fully inheriting their permissions DSL.

**Cons.** Inherits every schema coupling from Option A (CSV role,
missing `deleted_at`, camelCase, `activeOrganizationId` session
state) without the compensating benefit of using BA's permission
APIs. Agents still need a separate membership path regardless.
Worst of both worlds.

The "free invite flow" argument is speculative for our trajectory —
v1 is one-workspace-per-user with no invites. When invites land
(multi-workspace slice), we evaluate BA's `invitation` semantics
independently; adopting them doesn't require adopting the `member`
table shape. Decouplable.

Rejected.

### C. Custom `workspace_members` table; Better Auth for credentials only — CHOSEN

editorzero owns the membership schema, lifecycle, and role-source.
BA's core tables (`user` / `session` / `account` / `verification`)
remain the credential and session substrate. No BA access-control
plugins adopted.

**Pros.**
- Schema matches architecture §3.4 exactly: snake_case, UUIDv7
  IDs, composite PK `(workspace_id, user_id)`, `deleted_at` for ADR
  0017 cascade, singular `role TEXT NOT NULL`.
- `workspace` stays the authz primitive everywhere. No double-speak.
- Agents go through a separate resolution path (ADR 0016 — API-key
  token → `metadata.agent_id` → `agents` row → `AgentPrincipal`)
  with no impedance mismatch. Agents do **not** have
  `workspace_members` rows; their workspace binding comes from the
  token, their scopes ride directly on the principal.
- `PermissionGate` + `ROLE_SCOPES` + `capability.requires` are
  unchanged. One resolver-side change; no downstream ripple.
- No coupling to any BA plugin schema. BA major-version upgrades
  don't touch the authz path.
- Orgs-above-workspaces or teams-within-workspaces layer **above**
  this foundation (sibling tables + composite ACL resolver in the
  gate) without refactoring the member shape. Future-flexibility
  preserved.

**Cons.**
- No free invite flow. We write it when multi-workspace demands it.
- No `activeOrganizationId` session switching. We already resolve
  workspace per request; this is a feature, not a bug.
- BA's `createAccessControl` DSL isn't leveraged. But we already
  have `ROLE_SCOPES` in code (architecture §3.4 codifies this
  posture). The DSL is a lateral refactor, not a capability.

### D. BA Admin plugin for platform operators + custom workspace_members for workspace membership

Hybrid. BA admin plugin covers "operator of the deployment" (ban,
impersonate, platform user management). Custom `workspace_members`
covers per-workspace roles.

**Pros.** Ban / impersonate / session-revocation primitives
ready-made for a future operator role.

**Cons.** Two concepts called "admin" in the stack — BA's
platform-wide `admin` vs our workspace-scoped `admin`. Cognitive
overhead; easy to conflate in code. We don't have operators today
(single-user MVP) and won't until self-hosted deployments
materialize; pre-optimization. When platform-admin becomes a real
need, adopting BA's admin plugin is decoupled from this decision
— it can land then without touching `workspace_members`.

Rejected for this slice; open for a later, independent ADR if
platform-admin becomes load-bearing.

## Decision

**Adopt Option C.** editorzero owns `workspace_members`. BA remains
the credential and session substrate only. No BA access-control
plugins adopted at this time.

## Mechanics

### 1. DDL

```
workspace_members(
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  user_id         TEXT NOT NULL REFERENCES user(id),
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','member','guest')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  PRIMARY KEY (workspace_id, user_id)
)
```

- FK target is `user` (singular), matching Better Auth's default
  table name (not overridden in `create-auth.ts`). Architecture
  §3.4's `REFERENCES users(id)` spelling is stale and will be
  widened in the slice landing this ADR's implementation.
- `updated_at` is included for symmetry with `docs` (and future
  `collections`) and to support revive-in-place semantics when
  `workspace.add_member` / `workspace.update_member_role` land.
  Architecture §3.4's sketch widens to match.
- `role` enum'd at the CHECK level against the `Role` union in
  `@editorzero/scopes`.
- `deleted_at` for ADR 0017 soft-delete cascade. Workspace delete
  → all member rows soft-deleted transitively.

### 2. Resolver widening

`createBetterAuthResolver` takes a seam — a small
`loadRoles(workspace_id, user_id): Promise<readonly Role[] | null>`
helper — and queries `workspace_members` for the authenticated
session's role. Keeps the DB query isolated for testability and
avoids threading the driver into the resolver directly.

Missing membership row ⇒ `null` ⇒ 401. This is strict, matching the
existing strict-on-missing-workspaceId branch (`resolver.ts:62–63`).
Permanent fallback to `["member"]` preserves the current bug under
a different shape; once the table exists, its absence is a
structural error, not a default.

### 3. Backfill migration — trivial (pre-production tree)

No production deploys exist yet, so no existing users need a
backfill for this slice to land safely. When the first production
deploy approaches, a one-time
`INSERT workspace_members(workspace_id, user_id, role, created_at,
updated_at) SELECT user.workspaceId, user.id, 'owner',
user.createdAt, user.createdAt FROM user WHERE user.workspaceId IS
NOT NULL AND NOT EXISTS (...)` runs alongside the deploy to cover
every pre-hook user; post-hook signups are covered by item 4.

### 4. Signup bootstrap — BA after-hook (lands with this ADR)

BA 1.6.5's `databaseHooks.user.create.after` runs **post-commit**,
not inside the user-insert tx. Sources: BA docs describe after
hooks as post-create actions; the shipped runtime
(`better-auth/dist/db/with-hooks.mjs`) queues them via
`queueAfterTransactionHook`, and `@better-auth/core`'s
`runWithTransaction` drains `pendingHooks` only after `adapter.
transaction(...)` resolves. Atomic user + membership insert
through BA's public hook API is structurally unsupported.

The shipped approach: **BA `user.create.after` inserts the
`workspace_members` row as `role: "owner"` post-commit.** The
signing-up user owns the workspace they just minted, so `"owner"`
is the structurally correct role. `onConflict((oc) => oc.columns([
"workspace_id", "user_id"]).doNothing())` makes the insert
retry-safe without clobbering a soft-deleted revive state.

Atomicity caveat: if the `after` hook fails between user-commit
and membership-insert, BA's `signUpEmail` throws (the hook
propagates its error via `runWithTransaction`'s `pendingHooks`
loop). The user row is committed but the client sees a 500. Net
state: orphaned user row, no session. This is **strictly better
than a silent-401 on first request**; recovery costs the user a
retry (which hits the user-email uniqueness constraint) or a
background reconcile (out of scope for MVP). The observable
failure surface is "rare signup 500" rather than "every fresh
signup 401s forever" — the latter was the production gap Codex
caught before commit.

Two future evolutions this shape composes into:
- **Own signup orchestration.** Custom `/auth/signup` route that
  wraps `auth.api.signUpEmail` + `workspace_members` insert in one
  editorzero-owned tx. Gives us atomicity; costs us BA's default
  signup flow semantics. Revisit if the after-hook failure rate
  ever becomes observable.
- **Invite-driven signup.** When multi-workspace lands (item 6),
  the `before` hook resolves the workspace from invitation
  context instead of minting a fresh one, and the `after` hook
  inserts membership with the invite's role. No change to the
  hook shape — only the data source shifts.

### 5. Revive-in-place semantics

Composite PK `(workspace_id, user_id)` + `deleted_at` means a
re-add of a previously-soft-deleted membership is a `deleted_at =
NULL` + potentially `role = ?` + `updated_at = now` UPDATE, not an
INSERT (which would collide on the PK). The eventual
`workspace.add_member` capability codifies this in its handler
contract and tests — ensures intent is explicit, not accidental.

### 6. Invite flow — out of scope

`workspace.invite_member` is future work when multi-workspace
demand materializes. At that point, evaluate BA's `invitation`
plugin (distinct from the org plugin; callable independently) vs
writing custom — decoupled from this ADR. If BA's invitation state
machine (token + expiry + accept/reject/cancel) maps cleanly onto
our workspace-centric model, adopt; otherwise, custom.

### 7. AgentPrincipal membership

Agents do **not** have `workspace_members` rows. Their workspace
binding is `api_key.referenceId = workspace_id` (architecture §3.3
+ ADR 0016). Scopes ride on the `AgentPrincipal.scopes` field
directly, bypassing `ROLE_SCOPES`. If "agent as first-class member
in a workspace-members table" becomes a product need (e.g.,
listing all principals in a workspace uniformly), that's a
follow-up ADR — either widening `workspace_members` with a
polymorphic principal column, or a sibling `workspace_agents`
table.

### 8. Member CRUD capability surface (landed 2026-04-22)

The capabilities §5 anticipated shipped as a quartet. **Note the registry uses noun-first IDs** — `workspace.member_add` / `member_list` / `member_remove` / `member_update_role` — not the verb-second spellings (`add_member`, `update_member_role`, `invite_member`) this ADR's prose used while they were still future work. All four are `workspace:admin`; the three mutators are metadata-only.

- **`member_add`** — three-branch on `(workspace_id, user_id)`: live row → 409 `MemberAlreadyExistsError` (code `member_already_exists`; role changes go through `member_update_role`); soft-deleted → revive-in-place (§5); no row → INSERT `… ON CONFLICT (workspace_id, user_id) DO NOTHING RETURNING` → zero-row re-throws the 409 (keeps the conflict projection in-handler; the global mapper deliberately does **not** project raw `23505`, so duplicate-key-is-safe never masks a real integrity bug). No last-owner guard — add only grows the set. Slice-1 is `user_id`-direct (no email/invite — §6).
- **`member_update_role`** — 404 missing/soft-deleted; 400 `role_unchanged` no-op; **409 `LastOwnerError`** (code `last_owner_protected`) if it would demote the only live owner. COUNT+UPDATE atomic in the write-path tx.
- **`member_remove`** — soft-delete (§5 `deleted_at`), **not** idempotent (re-remove → 404, preserving the "already gone" signal); self-removal allowed (the last-owner guard blocks the dangerous case — an owner cannot leave until another owner exists).
- **`member_list`** — paginated by composite `(created_at, user_id)` cursor (both-or-neither refine), active-only in slice 1, `role` filter, read-collapsible.

The last-owner invariant holds on SQLite via single-writer `BEGIN IMMEDIATE`; on Postgres SERIALIZABLE two concurrent demotions can both pass their snapshots — the loser aborts `40001`, which the global error mapper projects to 409 `conflict` (bounded retry deferred).

## Consequences

- AGENTS.md invariant 6 (soft-deletes recoverable) becomes
  human-reachable end-to-end after the slice lands.
- `doc.publish` / `doc.unpublish` / `doc.delete` / `doc.restore`
  happy-path allow tests in `auth-chain.integration.test.ts`
  unblock for `owner`-role principals.
- AGENTS.md invariant 5 (no surface re-implements authz) holds —
  role resolution lives in the principal middleware (single
  trunk); surfaces never re-implement it.
- ADR 0016's peer-principal model preserved — agents stay
  structurally separate from the membership table.
- `ROLE_SCOPES` stays in code (architecture §3.4). No DB-driven
  role DSL, no `createAccessControl` adoption.
- BA upgrade path stays clean — no authz-critical BA plugin tables
  to migrate.
- `workspace` remains the authz primitive. Orgs / teams layers can
  be added above without refactoring this foundation.
- `workspace_members.role` is a **singular scalar**. Multi-role
  per user-in-workspace (if it ever becomes needed) would be a
  widening, not a replacement — and is not anticipated.

## Revisit triggers

- **Multi-workspace + invite flow lands.** Evaluate BA's
  `invitation` surface (independent of the org plugin) for the
  invite state machine. If it fits, adopt; otherwise, custom.
  Doesn't touch the membership table shape.
- **Orgs-above-workspaces product requirement.** New
  `organizations` table + nullable `workspaces.organization_id`
  FK; `workspace_members` stays unchanged; `organization_members`
  is a sibling table if org-level membership (and org-level roles)
  becomes distinct from workspace-level. New ADR, new slice.
- **Teams-within-workspaces product requirement.** `workspace_teams`
  + `team_members` + an ACL-resolver layer in `PermissionGate`
  composing `workspace_role ⊕ team_acl ⊕ collection_acl`. New
  ADR, new slice.
- **Platform-admin / operator role becomes load-bearing.**
  Evaluate BA's admin plugin for the operator level (ban,
  impersonate, cross-tenant session revoke). Independent of this
  ADR.
- **BA Organization plugin gains soft-delete, singular-role, and
  agent-compatible member shape simultaneously.** Re-evaluate
  full adoption. (Very unlikely — these are distinct design axes
  their roadmap hasn't flagged.)
- **`createAccessControl` materially improves over static
  `ROLE_SCOPES`** (e.g., build-time type-safety on role definitions
  catches a class of bugs the static table allows). Lateral
  refactor of `ROLE_SCOPES` to be built via `ac.newRole()` without
  changing the gate contract. Low priority.
- **A second frontier model (cross-model review at ADR boundary)
  rejects Option C on grounds this ADR doesn't anticipate.**
  Revisit.

## Cross-references

- **Refines** ADR 0010 (Better Auth spine) — records that BA's
  organization / admin / access-control plugins were evaluated and
  **not** adopted for MVP; BA remains credentials + sessions + (per
  ADR 0016) api-key + agent-auth only.
- **Binds** ADR 0016 (principal model) — preserves agents as
  structurally separate from the workspace-members table.
- **Binds** ADR 0017 (soft-delete recovery) — adds `deleted_at`
  to the members table so workspace-level soft-delete cascades to
  memberships without a separate table.
- **Binds** architecture.md §3.4 — widens the DDL sketch (adds
  `updated_at`, fixes FK target to `user`) in the slice landing
  this ADR's implementation.

## Sources

- Better Auth LLM index: https://better-auth.com/llms.txt
- Organization plugin: https://better-auth.com/docs/plugins/organization
- Admin plugin: https://better-auth.com/docs/plugins/admin
- API Key plugin: https://better-auth.com/docs/plugins/api-key
- Agent Auth plugin: https://better-auth.com/docs/plugins/agent-auth
- Access-control DSL (shared by Organization + Admin plugins; import
  path `better-auth/plugins/access`)
- BA 1.5 post-commit after hooks: behaviour confirmed in release
  blog + runtime (`better-auth/dist/db/with-hooks.mjs` →
  `queueAfterTransactionHook`)
- `packages/auth/src/resolver.ts:74` — hardcoded `roles: ["member"]`
- `packages/dispatcher/src/gate.ts:58–108` — `ROLE_SCOPES` static
  table
- `packages/auth/src/create-auth.ts:173–178` — existing signup hook
  that mints `workspaceId`
- Architecture.md §3.4 — canonical (to-be-widened) DDL sketch
