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
  "agent:create",
  "agent:revoke",
  "admin",
] as const;

export type Scope = (typeof SCOPES)[number];

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

export const SUBJECT_KINDS = [
  "workspace",
  "collection",
  "doc",
  "block",
  "comment",
  "attachment",
  "agent",
  "user",
  "token",
  "mirror",
  "system",
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

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
 * The `transact-called-at-most-once` arch-lint rule allows zero
 * `ctx.transact` calls for capabilities in this set; a contract test
 * asserts `capability.category === "mutation"` for every member.
 */
export const METADATA_ONLY_CAPABILITIES = [
  "block.set_visibility",
  "doc.publish",
  "doc.unpublish",
  "doc.move",
  "collection.create",
  "collection.update",
  "collection.move",
  "collection.delete",
  "collection.restore",
] as const;

export type MetadataOnlyCapabilityId = (typeof METADATA_ONLY_CAPABILITIES)[number];

export function isMetadataOnlyCapability(id: string): id is MetadataOnlyCapabilityId {
  return (METADATA_ONLY_CAPABILITIES as readonly string[]).includes(id);
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
    "agent:create",
    "agent:revoke",
  ],
};
