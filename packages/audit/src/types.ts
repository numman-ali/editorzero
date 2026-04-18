/**
 * Audit supporting types — envelope, outcomes, block/doc shapes.
 */

import type {
  AgentId,
  AttachmentId,
  BlockId,
  CapabilityId,
  CollectionId,
  CommentId,
  CustomDomainId,
  DocId,
  MirrorId,
  SessionId,
  TokenId,
  UserId,
  VersionId,
  WebhookId,
  WorkspaceId,
} from "@editorzero/ids";
import type { Role, Scope, SubjectKind } from "@editorzero/scopes";

// Re-export so audit consumers don't need `@editorzero/scopes` for Role alone.
export type { Role };

// ── Visibility enums (§3.5, §3.6) ──────────────────────────────────────────

export type DocVisibility = "workspace" | "public" | "private";
export type BlockVisibility = "default" | "internal" | "public";

// ── Canonical post-states used by AuditEffect ──────────────────────────────

/**
 * What ends up in the `blocks` projection. NOT the Yjs binary update
 * (invariant 3b owns that).
 */
export interface BlockPostState {
  id: BlockId;
  doc_id: DocId;
  type: string;
  parent_block_id: BlockId | null;
  order_key: string;
  content_json: unknown;
  visibility: BlockVisibility;
}

/**
 * Full preimage of a doc at purge time — feeds the 24h restore-token
 * escape hatch (§3.11, ADR 0017).
 */
export interface DocPurgePreimage {
  doc_id: DocId;
  title: string;
  collection_id: CollectionId | null;
  visibility: DocVisibility;
  blocks: BlockPostState[];
  snapshot_seq_at_purge: number;
}

// ── Deny / Error variants (F32 — §9.3) ─────────────────────────────────────

export type DenyReason =
  | { kind: "missing_scope"; required: Scope[]; principal_scopes: Scope[] }
  | { kind: "cross_workspace" }
  | { kind: "human_only" }
  | { kind: "rate_limited"; bucket: string; retry_after_ms: number }
  | { kind: "acl_deny"; scope: { doc_id: DocId } | { collection_id: CollectionId } }
  | { kind: "sub_block_acl_not_implemented" };

export type HandlerError =
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found"; subject_kind: SubjectKind; subject_id: string }
  | { kind: "conflict" }
  | { kind: "resource_limit"; detail: string }
  | { kind: "upstream"; service: string; status: number }
  | { kind: "internal"; trace_id: string };

export interface AuditDeny {
  kind: "deny";
  capability: CapabilityId;
  required_scopes: Scope[];
  reason_code: string;
}

export interface AuditError {
  kind: "error";
  capability: CapabilityId;
  error_code: string;
  retriable: boolean;
}

// ── Collapse policy (§9.3) ─────────────────────────────────────────────────

/** Only `category = "read"` capabilities may set `collapsible: true`. */
export type CollapsePolicy =
  | { collapsible: false }
  | { collapsible: true; collapseKey: (input: unknown) => string; window_ms: 1_000 };

// ── Audit envelope (§9.3) ──────────────────────────────────────────────────
//
// The DB row (`audit_events`) stores `outcome` + `effect` JSON. The replay
// reducer keys off `outcome` to pick the correct reducer branch:
//   - `"allow"` → AuditEffect (state-mutating)
//   - `"deny"` / `"error"` → no-op in PersistentWorkspaceState replay

import type { AuditEffect } from "./effect";

export type AuditRecord =
  | { outcome: "allow"; effect: AuditEffect }
  | { outcome: "deny"; reason: DenyReason; effect: AuditDeny }
  | { outcome: "error"; error: HandlerError; effect: AuditError };

// Re-export the ID brands audit-effect variants consume so downstream
// packages only need `@editorzero/audit`.
export type {
  AgentId,
  AttachmentId,
  BlockId,
  CapabilityId,
  CollectionId,
  CommentId,
  CustomDomainId,
  DocId,
  MirrorId,
  SessionId,
  TokenId,
  UserId,
  VersionId,
  WebhookId,
  WorkspaceId,
};
