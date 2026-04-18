/**
 * Audit supporting types — envelope, outcomes, block/doc shapes.
 */

import type { DenyReason, HandlerError } from "@editorzero/errors";
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
import type { Role, Scope } from "@editorzero/scopes";

// Re-exported from their owning packages so an audit consumer only
// needs `@editorzero/audit`. `DenyReason` / `HandlerError` live with
// `EditorZeroError` in `@editorzero/errors` (each subclass owns the
// projection to `HandlerError`); `Role` lives in `@editorzero/scopes`.
export type { DenyReason, HandlerError, Role };

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

// ── Deny / Error audit envelopes (F32 — §9.3) ──────────────────────────────
//
// `DenyReason` / `HandlerError` themselves live in `@editorzero/errors`
// (re-exported at the top of this file). The envelopes below are the
// flattened shape persisted to `audit_events` — reason / error code,
// retriable flag, etc.

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

/**
 * Only `category = "read"` capabilities may set `collapsible: true`.
 *
 * `window_ms` is typed as `number` (not a literal) so capabilities can
 * source it from `@editorzero/constants.AUDIT_READ_COLLAPSE_WINDOW_MS`
 * without a cast. The spec intent is "all read-collapse windows share
 * one floor" — a type-level literal would duplicate the SSOT here and
 * force a sweep every time the constant changes. Callers MUST import
 * the constant; a future coherence / arch-lint rule will enforce that
 * `window_ms` is never a literal at the call site (F93).
 */
export type CollapsePolicy =
  | { collapsible: false }
  | { collapsible: true; collapseKey: (input: unknown) => string; window_ms: number };

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
