/**
 * Scope vocabulary + typed invariant enumerations (architecture.md §8.4, §6.5).
 *
 * The exported `as const` arrays are the canonical membership lists. Docs
 * and contract tests read these — hand-maintained duplicate lists are the
 * drift anti-pattern this package prevents.
 */

// ── Scope vocabulary (ADR 0016) ────────────────────────────────────────────

export const SCOPES = [
  "doc:read",
  "doc:write",
  "doc:delete",
  "doc:publish",
  "block:read",
  "block:write",
  "comment:read",
  "comment:write",
  "comment:resolve",
  "search:read",
  "workspace:read",
  "workspace:admin",
  "permission:grant",
  "permission:revoke",
  "space:manage",
  "agent:create",
  "agent:revoke",
  "admin",
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * The universe an agent token's scopes may draw from (ADR 0044
 * Decision 1, the non-amplification rule). Exactly `SCOPES` minus the
 * literal `"admin"` scope: NO agent token ever carries it, from any
 * caller — every `admin`-scoped capability is `humanOnly` (§8.5), so
 * the scope would be dead weight on an agent, and §8.4's old
 * "operator grants `admin` via tier=custom" allowance is retired.
 * The second half of the rule (an agent caller mints ⊆ its own
 * effective scopes) is enforced at `agent.token_mint`, not here.
 */
export const AGENT_MINTABLE_SCOPES = SCOPES.filter(
  (s): s is Exclude<Scope, "admin"> => s !== "admin",
);

export type AgentMintableScope = (typeof AGENT_MINTABLE_SCOPES)[number];

/**
 * The mint-time intent label stored on an agent token row (ADR 0044):
 * the named tiers plus `"custom"` for an explicit scope list. Display
 * and audit record ONLY — scopes are expanded at mint and never
 * re-derived from the label (tiers are computed-once; editing a tier
 * definition never re-scopes existing tokens).
 */
export const AGENT_TOKEN_TIERS = ["read-only", "author", "editor", "admin", "custom"] as const;
export type AgentTokenTier = (typeof AGENT_TOKEN_TIERS)[number];

// ── Capability categories (§4.1) ───────────────────────────────────────────

export const CAPABILITY_CATEGORIES = ["mutation", "read", "auth", "admin", "system"] as const;
export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

// ── Surfaces (§5) ──────────────────────────────────────────────────────────
//
// Every type-compatible capability is exposed on every listed surface —
// invariant #4, enforced by the contract-matrix test.

export const SURFACES = ["api", "cli", "mcp", "ui"] as const;
export type Surface = (typeof SURFACES)[number];

// ── Fidelity tier (ADR 0013) ───────────────────────────────────────────────

export const FIDELITY_TIERS = ["lossless", "directive", "opaque"] as const;
export type FidelityTier = (typeof FIDELITY_TIERS)[number];

// ── Principal kind (§3.3) ──────────────────────────────────────────────────

export const PRINCIPAL_KINDS = ["user", "agent"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

// ── Workspace role (§3.4) ──────────────────────────────────────────────────

export const ROLES = ["owner", "admin", "member", "guest"] as const;
export type Role = (typeof ROLES)[number];

// ── Subject kind (§3.11 audit) ─────────────────────────────────────────────
//
// `space` / `grant` joined with ADR 0040 Step 3 (audit subjects for the
// Step-7/8 `space.*` / `permission.*` effects; `team` lands with the
// Teams slice). Widening is additive: the only schema consumer is the
// audit-list filter enum, so existing values keep their meaning.

export const SUBJECT_KINDS = [
  "workspace",
  "space",
  "collection",
  "doc",
  "block",
  "comment",
  "attachment",
  "agent",
  "user",
  "token",
  "grant",
  "mirror",
  "system",
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

// ── Grant role + access mode (ADR 0040) ────────────────────────────────────

/**
 * Per-resource grant vocabulary (`grants.role`) — DISTINCT from the
 * workspace-membership `ROLES` above. The two share the word "owner"
 * but are different vocabularies with different semantics; conflating
 * them is a real drift hazard, so tests pin `GRANT_ROLES` separately
 * (ADR 0040, structural fork #3).
 *
 * Positive-only by design (fork #5): there are no deny rows, so
 * "who-can-read X" stays a positive union — audit- and replay-friendly.
 * Narrowing below the Space baseline is expressed by flipping the doc to
 * `access_mode = "private"` + an explicit allow-list, never by a
 * per-member deny.
 */
export const GRANT_ROLES = ["owner", "edit", "comment", "view"] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];

/**
 * Doc-level access mode (ADR 0040 fork #5 resolution — the Codex HIGH 1
 * fork): `"space"` = the Space baseline applies and grants may only
 * raise; `"private"` = allow-list of `created_by` + explicit grants +
 * guests. Becomes the `docs.access_mode` column at Step 5 (the
 * visibility de-overload split).
 */
export const ACCESS_MODES = ["space", "private"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/**
 * Space kind (ADR 0040 Model B): `"team"` = a shared membership
 * boundary; `"personal"` = one member's private-drafts home
 * (`spaces.owner_user_id` non-null iff personal — the DDL CHECK ties
 * the two). One personal space per member, seeded by the signup hook
 * (Step 8); enforced by the partial unique index on
 * `(workspace_id, owner_user_id) WHERE kind = 'personal'`.
 */
export const SPACE_KINDS = ["team", "personal"] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/**
 * Space type — the membership/visibility posture (ADR 0040 Model B's
 * "default baseline (Open/Closed/Private)"): `"open"` = every Org
 * member implicitly reads at the Space's `baseline_access` role
 * without a membership row; `"closed"` = visible in the directory,
 * access requires membership; `"private"` = membership-only and
 * unlisted. The Step-6 resolver is the single consumer of these
 * semantics (invariant 5 — no surface re-derives them).
 */
export const SPACE_TYPES = ["open", "closed", "private"] as const;
export type SpaceType = (typeof SPACE_TYPES)[number];

/**
 * Baseline-access roles — the GRANT_ROLES subset a Space may confer
 * implicitly on Org members (`spaces.baseline_access` CHECK). `owner`
 * is deliberately excluded: an implicit everyone-is-owner baseline is
 * never valid (the DDL CHECK and this array must agree — Check 11
 * covers the column, this is the TS-side source for schemas).
 */
export const BASELINE_ACCESS_ROLES = ["edit", "comment", "view"] as const;
export type BaselineAccessRole = (typeof BASELINE_ACCESS_ROLES)[number];

// ── Queue name (§3.14) ─────────────────────────────────────────────────────

export const QUEUE_NAMES = [
  "projection_blocks",
  "embed",
  "search_reindex",
  "mirror.project_doc",
  "mirror.push",
  "mirror.reconcile",
  "reaper",
  "compaction",
  "webhook",
  "email",
  "dcr_cleanup",
  "restore_search",
  "purge",
  "outbox_forwarder",
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

// ── Metadata-only capability set (§6.5 / AGENTS.md invariant 7) ────────────

/**
 * Capabilities that legally take the dispatcher-owned DB tx **without**
 * opening a Hocuspocus direct connection. These mutate relational
 * metadata only; no Y.Doc content changes.
 *
 * `doc.rename` is NOT in this set (F54): the doc title lives in the title
 * block of the Y.Doc, so `doc.rename` is a content mutation via
 * `ctx.transact` like any other.
 *
 * `doc.delete` / `doc.restore` ARE in this set (ADR 0017): soft-delete is
 * a `docs.deleted_at` flip; blocks + `doc_updates` are preserved on
 * delete and recovered-in-place on restore, so the Y.Doc itself is never
 * mutated. Search-index rebuild + embeddings re-activation + notification
 * cancellation (ADR 0017 cascade) run as post-commit jobs, not inside the
 * write-path tx.
 *
 * The planned `transact-called-at-most-once` arch-lint rule will
 * allow zero `ctx.transact` calls for capabilities in this set
 * (F89 — the `@editorzero/arch-lint` package is not yet implemented).
 * A contract test asserts `capability.category === "mutation"` for
 * every member.
 */
export const METADATA_ONLY_CAPABILITIES = [
  "block.set_visibility",
  "doc.publish",
  "doc.unpublish",
  "doc.delete",
  "doc.restore",
  "doc.move",
  "collection.create",
  "collection.update",
  "collection.move",
  "collection.delete",
  "collection.restore",
  "workspace.update",
  "workspace.member_add",
  "workspace.member_remove",
  "workspace.member_update_role",
  // ADR 0040 Step 3 — Model B mutators, reserved ahead of their Step-8
  // capabilities so the write-path posture (dispatcher-tx-only, no
  // Hocuspocus connection) is settled before any handler exists. None
  // is dispatchable until its `registerCapability` lands, so membership
  // here is zero-behaviour-change today. Coherence Check 3 keeps this
  // list in lockstep with architecture §6.5.
  "permission.grant",
  "permission.revoke",
  "space.create",
  "space.update",
  "space.archive",
  "space.restore",
  "space.member_add",
  "space.member_remove",
  "space.member_update_role",
  "doc.add_guest",
  "doc.remove_guest",
] as const;

export type MetadataOnlyCapabilityId = (typeof METADATA_ONLY_CAPABILITIES)[number];

// `Set<string>` widens the narrow tuple at assignment time (not via a
// cast) so `.has(arbitraryString)` is well-typed. The set is computed
// once at module init; `id` becomes a `MetadataOnlyCapabilityId` via
// the user-defined type guard when membership is confirmed.
const METADATA_ONLY_CAPABILITY_SET: ReadonlySet<string> = new Set(METADATA_ONLY_CAPABILITIES);

export function isMetadataOnlyCapability(id: string): id is MetadataOnlyCapabilityId {
  return METADATA_ONLY_CAPABILITY_SET.has(id);
}

// ── System-audit provenance markers (ADR 0041) ─────────────────────────────
//
// Synthetic `capability_id` values that may appear on `audit_events` rows
// produced OUTSIDE the dispatcher — system mutations that must still land in
// the audit log to keep invariant 3 ("the log alone reconstructs final state")
// whole. The canonical case is signup genesis: `create-auth.ts`'s post-commit
// hook writes the `workspaces` anchor + owner `workspace_members` row via
// `driver.system()`, neither through a capability dispatch, yet both create
// durable authority that replay must reconstruct.
//
// These ids are **non-dispatchable**: no `Capability` carries one, they have
// no scopes/handler/surfaces, and they never appear in Appendix A. The id is
// the provenance label on the audit envelope, not a dispatch target. The
// `system.` prefix (vs a `workspace.`-domain name) makes that unmistakable —
// system, not dispatch — and one marker labels both genesis rows (they differ
// by `effect` + `subject`).
//
// `scripts/coherence.ts` enforces that this set is DISJOINT from the
// implemented capability ids, so a marker can never silently become — or be
// shadowed by — a real capability. Reusable for future import / repair-job
// markers as those slices land.
export const SYSTEM_WORKSPACE_BOOTSTRAP = "system.workspace_bootstrap";

export const SYSTEM_AUDIT_CAPABILITY_IDS = [SYSTEM_WORKSPACE_BOOTSTRAP] as const;

export type SystemAuditCapabilityId = (typeof SYSTEM_AUDIT_CAPABILITY_IDS)[number];

// `Set<string>` widens the narrow tuple at assignment time (not via a cast) so
// `.has(arbitraryString)` is well-typed — same posture as the metadata-only set.
const SYSTEM_AUDIT_CAPABILITY_SET: ReadonlySet<string> = new Set(SYSTEM_AUDIT_CAPABILITY_IDS);

export function isSystemAuditCapabilityId(id: string): id is SystemAuditCapabilityId {
  return SYSTEM_AUDIT_CAPABILITY_SET.has(id);
}

// ── Default agent scope tiers (§8.4) ───────────────────────────────────────

export type AgentScopeTier = "read-only" | "author" | "editor" | "admin";

export const AGENT_SCOPE_TIERS: Readonly<Record<AgentScopeTier, readonly Scope[]>> = {
  "read-only": ["doc:read", "block:read", "comment:read", "search:read", "workspace:read"],
  author: [
    "doc:read",
    "block:read",
    "comment:read",
    "search:read",
    "workspace:read",
    "doc:write",
    "block:write",
    "comment:write",
  ],
  editor: [
    "doc:read",
    "block:read",
    "comment:read",
    "search:read",
    "workspace:read",
    "doc:write",
    "block:write",
    "comment:write",
    "doc:delete",
    "doc:publish",
    "comment:resolve",
  ],
  admin: [
    "doc:read",
    "block:read",
    "comment:read",
    "search:read",
    "workspace:read",
    "doc:write",
    "block:write",
    "comment:write",
    "doc:delete",
    "doc:publish",
    "comment:resolve",
    "permission:grant",
    "permission:revoke",
    "space:manage",
    "agent:create",
    "agent:revoke",
  ],
};
