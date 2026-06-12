/**
 * `AuditEffect` — discriminated union of every state-mutating audit
 * effect kind (architecture.md §16.3).
 *
 * The replay reducer in `packages/audit/test/replay.prop.ts` must have
 * a branch for every `kind`; the planned `audit-effect-exhaustiveness`
 * arch-lint rule will enforce exhaustive switches at compile time
 * (F89 — `@editorzero/arch-lint` is not yet implemented; today the
 * discipline is TypeScript's exhaustive-switch narrowing plus review).
 *
 * Every row in the Appendix A capability matrix whose "Audit effect kind"
 * column names a mutation has a corresponding variant here; the coherence
 * script's stub for `AuditEffect ↔ Appendix A` (scripts/coherence.ts) will
 * activate once this union is referenced from Appendix A checks.
 */

import type {
  AgentId,
  AttachmentId,
  BlockId,
  CollectionId,
  CommentId,
  CustomDomainId,
  DocId,
  MirrorId,
  TokenId,
  UserId,
  VersionId,
  WebhookId,
  WorkspaceId,
} from "@editorzero/ids";
import type { AccessMode, Scope } from "@editorzero/scopes";
import type { BlockPostState, BlockVisibility, DocPurgePreimage, Role, SeedBlock } from "./types";

// prettier-ignore
export type AuditEffect =
  // ── Reads (architecture.md §9.3) ─────────────────────────────────────────
  //
  // Read capabilities (`category: "read"`) project to this empty-bodied
  // variant. Reads are not state-mutating, so the replay reducer's branch
  // for this kind is a no-op — but the row still lands in `audit_events`
  // so forensic reconstruction of *who read what* is possible. The useful
  // identifying fields (`capability_id`, `principal_kind`, `principal_id`,
  // `subject_*`, `input_hash`) already live on the `AuditWriteInput`
  // envelope; duplicating them in the effect body would create a
  // must-stay-in-sync hazard for no gain.
  | { kind: "audit.access_log" }
  // ── Workspace lifecycle (§3.2) ───────────────────────────────────────────
  | {
      kind: "workspace.create";
      workspace_id: WorkspaceId;
      slug: string;
      name: string;
      created_by: UserId;
      // Carried so replay reconstructs the full workspace projection rather
      // than guessing DDL defaults: an admin who later changes retention or
      // settings, followed by a truncated log, would otherwise mis-
      // reconstruct (Codex review HIGH 3). `settings` is the *parsed* object
      // (the form `workspace.get` / `workspace.update` expose), not the
      // stored JSON string.
      trash_retention_days: number;
      settings: Record<string, unknown>;
    }
  | {
      kind: "workspace.update";
      workspace_id: WorkspaceId;
      // `settings` is the parsed object — tightened from `unknown` so the
      // reducer applies it without a cast (Codex review HIGH 3). The handler
      // carries the *post-JSON-round-trip* form (`JSON.parse` of the stringified
      // column it just wrote), i.e. exactly what a reader parses back, so the
      // replay→DB compare matches even for non-JSON-clean inputs.
      patch: Partial<{
        name: string;
        trash_retention_days: number;
        settings: Record<string, unknown>;
      }>;
    }
  // `deleted_at` is the exact `ctx.now()` the handler wrote to the row, carried
  // so replay reconstructs the ADR 0017 recovery-window anchor (the audit row's
  // own `created_at` is a different clock — Codex review HIGH 4). No shipped
  // capability emits `workspace.soft_delete` yet; the shape is the forward
  // guardrail for the eventual `workspace.delete` slice, which must return and
  // carry the same handler clock (not the envelope's) like its doc/collection/
  // member siblings.
  | { kind: "workspace.soft_delete"; workspace_id: WorkspaceId; deleted_at: number }
  | { kind: "workspace.restore"; workspace_id: WorkspaceId }
  | { kind: "workspace.purge"; workspace_id: WorkspaceId; member_count_at_purge: number }
  | { kind: "member.add"; workspace_id: WorkspaceId; user_id: UserId; role: Role }
  | { kind: "member.remove"; workspace_id: WorkspaceId; user_id: UserId; deleted_at: number }
  | { kind: "member.update_role"; workspace_id: WorkspaceId; user_id: UserId; role: Role }
  // ── Collection (§3.5) ────────────────────────────────────────────────────
  | {
      kind: "collection.create";
      collection_id: CollectionId;
      workspace_id: WorkspaceId;
      parent_id: CollectionId | null;
      title: string;
      slug: string;
      order_key: string;
      // The handler-resolved human attribution (the human behind an agent —
      // see the capability's `resolveCreatedBy`). Replay reads this, NOT the
      // envelope `principal_id`, which for an agent write is the agent, not
      // the human (Codex review HIGH 1).
      created_by: UserId;
    }
  | {
      kind: "collection.update";
      collection_id: CollectionId;
      patch: Partial<{ title: string; slug: string; order_key: string }>;
    }
  | {
      kind: "collection.move";
      collection_id: CollectionId;
      new_parent_id: CollectionId | null;
      new_order_key: string;
    }
  | { kind: "collection.soft_delete"; collection_id: CollectionId; deleted_at: number }
  | { kind: "collection.restore"; collection_id: CollectionId }
  // ── Doc (§3.5) ───────────────────────────────────────────────────────────
  // `seed_blocks` carries the pre-minted block IDs the handler passed
  // into `seedBlocks` + enough shape to replay them (type/props/content).
  // Closing invariant 3a for the initial `docs` row: a later
  // `doc.update` that references these blocks has stable IDs in the
  // audit log to refer to, not IDs freshly minted inside BlockNote that
  // the audit trail never saw.
  | {
      kind: "doc.create";
      doc_id: DocId;
      workspace_id: WorkspaceId;
      collection_id: CollectionId | null;
      title: string;
      slug: string;
      order_key: string;
      // The handler-resolved human attribution (the human behind an agent —
      // see the capability's `resolveCreatedBy`). Replay reads this, NOT the
      // envelope `principal_id`, which for an agent write is the agent, not
      // the human (Codex review HIGH 1).
      created_by: UserId;
      access_mode: AccessMode;
      seed_blocks: SeedBlock[];
    }
  // `slug` is re-derived from the new title by the handler (slugify) and
  // written to `docs.slug` in the same UPDATE as `title`, so replay must carry
  // it — else a renamed doc reconstructs with its stale create-time slug while
  // the live row moved on. Same effect-carries-the-handler-computed-value
  // contract as `collection.update` (which carries `slug` in its patch).
  | { kind: "doc.rename"; doc_id: DocId; title: string; slug: string }
  | {
      kind: "doc.move";
      doc_id: DocId;
      new_collection_id: CollectionId | null;
      new_order_key: string;
    }
  // `published_slug` is handler-COMPUTED (collision-suffixed against the
  // live published set), so the effect must carry it — replay can never
  // re-derive it (the same effect-carries-the-handler-computed-value
  // contract as `doc.rename`'s slug). On an idempotent re-publish both
  // values are the doc's existing ones (stable URL, original timestamp).
  | { kind: "doc.publish"; doc_id: DocId; published_slug: string; published_at: number }
  // Clears the publish dimension — deterministic (both fields land on
  // null), so no payload beyond the target.
  | { kind: "doc.unpublish"; doc_id: DocId }
  | { kind: "doc.soft_delete"; doc_id: DocId; deleted_at: number }
  | { kind: "doc.restore"; doc_id: DocId }
  | { kind: "doc.purge"; preimage: DocPurgePreimage }
  /** F66/F73 — transient; GC of expired tokens is auditable. */
  | { kind: "doc.reconcile_base_token"; doc_id: DocId; token: string; expires_at: number }
  // ── Block (projection state — invariant 3a) ──────────────────────────────
  | { kind: "block.insert"; doc_id: DocId; post: BlockPostState }
  | { kind: "block.update"; doc_id: DocId; post: BlockPostState }
  | { kind: "block.remove"; doc_id: DocId; block_id: BlockId }
  | { kind: "block.set_visibility"; doc_id: DocId; block_id: BlockId; visibility: BlockVisibility }
  // ── doc.update batch (F12 + F33) — one audit row per handler invocation ──
  | {
      kind: "doc.update_batch";
      doc_id: DocId;
      ops: Array<
        | {
            op: "insert";
            block: BlockPostState;
            after_block_id: BlockId | null;
            parent_block_id: BlockId | null;
          }
        | { op: "update"; block_id: BlockId; post: BlockPostState }
        | {
            op: "move";
            block_id: BlockId;
            new_parent_block_id: BlockId | null;
            new_order_key: string;
          }
        | { op: "remove"; block_id: BlockId; preimage: BlockPostState }
        | { op: "set_visibility"; block_id: BlockId; visibility: BlockVisibility }
      >;
    }
  // ── Version (§3.8) ───────────────────────────────────────────────────────
  | {
      kind: "version.create";
      doc_id: DocId;
      version_id: VersionId;
      name: string | null;
      snapshot_seq: number;
    }
  | {
      kind: "version.restore";
      doc_id: DocId;
      from_version_id: VersionId;
      pre_restore_version_id: VersionId;
      snapshot_seq_before: number;
      snapshot_seq_after: number;
    }
  // ── Comment (§3.9) / Attachment (§3.10) ──────────────────────────────────
  | {
      kind: "comment.create";
      comment_id: CommentId;
      doc_id: DocId;
      anchor: unknown;
      thread_root_id: CommentId | null;
      body_markdown: string;
    }
  | { kind: "comment.update"; comment_id: CommentId; body_markdown: string }
  | { kind: "comment.resolve"; comment_id: CommentId; resolved_by: UserId | AgentId }
  | { kind: "comment.soft_delete"; comment_id: CommentId }
  /** F57/F80 — pending upload; no final blob yet. */
  | {
      kind: "attachment.request_upload";
      upload_id: string;
      workspace_id: WorkspaceId;
      storage_key: string;
      declared_size: number;
      declared_content_type: string;
      declared_sha256: string | null;
      expires_at: number;
    }
  /** F57/F80 — upload confirmed; row in `attachments` with content-addressable storage_key. */
  | {
      kind: "attachment.confirm_upload";
      upload_id: string;
      attachment_id: AttachmentId;
      storage_key: string;
      filename: string;
      content_type: string;
      bytes: number;
      sha256: string;
    }
  | { kind: "attachment.soft_delete"; attachment_id: AttachmentId }
  // ── Permissions (§3.12) ──────────────────────────────────────────────────
  | {
      kind: "acl.grant";
      scope: { doc_id: DocId } | { collection_id: CollectionId };
      subject_kind: "user" | "agent" | "role";
      subject_id: string;
      access: "read" | "comment" | "edit" | "admin";
    }
  | {
      kind: "acl.revoke";
      scope: { doc_id: DocId } | { collection_id: CollectionId };
      subject_kind: "user" | "agent" | "role";
      subject_id: string;
    }
  // ── Principals (§3.3) ────────────────────────────────────────────────────
  | { kind: "agent.create"; agent_id: AgentId; owner_user_id: UserId | null; name: string }
  | { kind: "agent.rename"; agent_id: AgentId; name: string }
  | { kind: "agent.revoke"; agent_id: AgentId }
  | {
      kind: "token.create";
      token_id: TokenId;
      bound_to: { agent_id: AgentId } | { user_id: UserId };
      scopes: Scope[];
      expires_at: number | null;
    }
  | { kind: "token.revoke"; token_id: TokenId }
  // ── Mirror (§3.15, F50 + F58) ────────────────────────────────────────────
  | {
      kind: "mirror.configure";
      patch: Partial<{
        remote_url: string;
        branch: string;
        auth_kind: string;
        path_template: string;
        debounce_ms: number;
        batch_window_ms: number;
      }>;
    }
  | { kind: "mirror.enable" }
  | { kind: "mirror.disable" }
  | {
      kind: "mirror.reset_state";
      mirror_id: MirrorId;
      workspace_id: WorkspaceId;
      cleared_state: true;
      reprojected: boolean;
      touched_credentials: false;
    }
  | {
      kind: "mirror.reset_auth";
      mirror_id: MirrorId;
      workspace_id: WorkspaceId;
      revoked_secret_ref: true;
      disabled: boolean;
      cleared_state: false;
    }
  // ── Custom domain (§3.2, F50) ────────────────────────────────────────────
  | { kind: "custom_domain.add"; domain: string }
  | {
      kind: "custom_domain.verify";
      custom_domain_id: CustomDomainId;
      verification_method: "dns" | "http";
    }
  | { kind: "custom_domain.remove"; domain: string }
  // ── Webhooks (F56, §3.17) ────────────────────────────────────────────────
  | {
      kind: "webhook.created";
      webhook_id: WebhookId;
      workspace_id: WorkspaceId;
      url: string;
      events: string[];
      resolved_ip: string;
    }
  | {
      kind: "webhook.updated";
      webhook_id: WebhookId;
      patch: Partial<{
        url: string;
        events: string[];
        active: boolean;
        resolved_ip: string;
        resolution_policy: "manual" | "auto_on_failure";
      }>;
    }
  | { kind: "webhook.deleted"; webhook_id: WebhookId }
  | {
      kind: "webhook.rotated";
      webhook_id: WebhookId;
      new_secret_version: number;
      dual_accept_until: number;
    }
  | {
      kind: "webhook.circuit_broken";
      webhook_id: WebhookId;
      failure_count: number;
      broken_at: number;
    }
  | {
      kind: "webhook.test_delivery";
      webhook_id: WebhookId;
      delivery_id: string;
      status: number | null;
      error: string | null;
    }
  // ── Admin actions (F50) — replay is a no-op; enumerated for exhaustiveness
  | {
      kind: "admin.reembed_workspace";
      workspace_id: WorkspaceId;
      model_from: string;
      model_to: string;
    }
  | { kind: "admin.reindex_workspace"; workspace_id: WorkspaceId; index_kind: "fts" | "hnsw" }
  | { kind: "admin.evict_doc"; doc_id: DocId }
  | { kind: "admin.unlock_doc"; doc_id: DocId }
  | { kind: "admin.job_requeue"; job_id: string; queue: string }
  | { kind: "admin.job_cancel"; job_id: string; queue: string }
  | { kind: "admin.queue_pause"; queue: string }
  | { kind: "admin.queue_resume"; queue: string }
  | { kind: "admin.secret_rotate"; secret_kind: string; dual_accept_until: number }
  /**
   * Support-bundle export. `bundle_id` ties the audit row to the exported
   * artifact for later retrieval. `with_content` distinguishes default
   * redacted export from the operator-cosigned raw-content variant
   * (§9.7). Appendix A row references this kind; §16.3 omitted it — drift
   * fix.
   */
  | {
      kind: "admin.diagnose";
      workspace_id: WorkspaceId;
      bundle_id: string;
      with_content: boolean;
    };
