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
import type { AccessMode, Role, Scope } from "@editorzero/scopes";

// Re-exported from their owning packages so an audit consumer only
// needs `@editorzero/audit`. `DenyReason` / `HandlerError` live with
// `EditorZeroError` in `@editorzero/errors` (each subclass owns the
// projection to `HandlerError`); `Role` / `AccessMode` live in
// `@editorzero/scopes` (`AccessMode` is the ADR 0040 Step-5 successor
// to the retired tri-state `DocVisibility` — publish is now the
// orthogonal `published_slug`/`published_at` pair, not an enum value).
export type { AccessMode, DenyReason, HandlerError, Role };

// ── Visibility enums (§3.6) ────────────────────────────────────────────────

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
 * `SeedBlock` — the pre-minted-ID, pre-seed representation of a block
 * captured on the `doc.create` audit effect (§16.3). Enough to replay
 * `seedBlocks(ydoc, seed_blocks)` deterministically:
 *
 *   - `id` is **pre-minted** by the handler (via `generateBlockId()`)
 *     and passed into BlockNote's `PartialBlock.id` — BlockNote respects
 *     provided IDs, so what lands in the Y.Doc fragment matches what
 *     the audit row records. Invariant 3a (replay reconstructs final
 *     state) becomes true for the initial block-ID assignment.
 *   - `type` / `props` / `content` mirror BlockNote's `PartialBlock`
 *     (heading / paragraph / … as the block registry grows). `content`
 *     is `unknown` because BlockNote's `PartialInlineContent[] | string`
 *     union cannot be narrowed without pulling BlockNote's type tree
 *     into `@editorzero/audit`; the replay path re-validates by
 *     routing through `seedBlocks` itself (same validator both sides).
 *
 * Contrast with `BlockPostState` below: that shape is for post-create
 * block mutations (insert / update / remove), which carry doc-scoped
 * bookkeeping (`parent_block_id`, `order_key`, per-block visibility)
 * that a top-level seed does not yet have.
 */
export interface SeedBlock {
  id: BlockId;
  type: string;
  // Shape intentionally matches the zod inference on the `doc.create`
  // Output's `seed_blocks` field (see `packages/capabilities/src/doc/
  // create.ts`). Under `exactOptionalPropertyTypes: true` a zod
  // `z.record(...).optional()` emits `Record<..> | undefined` (present,
  // possibly undefined) — not the `prop?: X` form (possibly-absent).
  // Declaring these fields with the explicit `| undefined` union keeps
  // the interface assignable from the zod-inferred type without a cast
  // at the call site. `content` is already `unknown`, which covers the
  // same ground.
  props?: Record<string, unknown> | undefined;
  content?: unknown;
}

/**
 * Full preimage of a doc at purge time — feeds the 24h restore-token
 * escape hatch (§3.11, ADR 0017).
 */
export interface DocPurgePreimage {
  doc_id: DocId;
  title: string;
  collection_id: CollectionId | null;
  access_mode: AccessMode;
  // Publish dimension at purge time. Soft-delete already cleared these
  // (a trashed doc leaves the public site), so for a purge after the
  // normal trash flow they are null — carried anyway so the preimage
  // mirrors the row, not an assumption about how it got here.
  published_slug: string | null;
  published_at: number | null;
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
