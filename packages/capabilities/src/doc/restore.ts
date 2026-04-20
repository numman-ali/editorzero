/**
 * `doc.restore` — revive a soft-deleted doc (ADR 0017;
 * `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`; AGENTS.md
 * invariant 6).
 *
 * Pair of `doc.delete`. Same metadata-only lane: no `ctx.transact`, no
 * Y.Doc touching, no `doc_updates` row. Single UPDATE on the `docs`
 * row that flips `deleted_at` from non-NULL to NULL. Blocks,
 * `doc_updates`, and `doc_snapshots` are still there (ADR 0017
 * preserves them on delete), so restore is a pure liveness flip —
 * the Y.Doc is bit-identical to the pre-delete state modulo the
 * audit trail (the inverse-restore property test anchors this).
 *
 * **Scope.** `doc:delete`. Same scope as `doc.delete`. See
 * `doc/delete.ts` header for rationale; splitting delete/restore
 * across different scopes leaves docs stuck in trash when the
 * original deleter's role is revoked.
 *
 * **Not-deleted handling.** A `deleted_at IS NULL` doc returns 404.
 * Restoring a doc that isn't trashed has no defined meaning — the
 * caller already has the state they wanted; silently returning 200
 * would muddle the audit log with no-op restore rows. Callers
 * observing 404 on a restore retry know the doc is live, which is
 * what they wanted anyway. (Also: no state change means no
 * `visibility_version` bump, which matches the already-deleted short-
 * circuit in `doc.delete` — see the idempotency rationale there.)
 *
 * **Audit effect.** `{ kind: "doc.restore", doc_id }`. Symmetric with
 * `doc.soft_delete` — no timestamp field on the effect (the audit
 * row's own `created_at` envelope is authoritative). The capability
 * *id* stays `doc.restore`; no asymmetry here (unlike delete's
 * `doc.delete` id → `doc.soft_delete` effect split, because there's
 * no "hard restore" to disambiguate from).
 *
 * **Public-route cache invalidation — `visibility_version` bump.**
 * Symmetric with `doc.delete`: a restore of a *published* doc flips
 * the public-route from "404" back to "renders", which only survives
 * cache invalidation if `visibility_version` bumps. Same
 * `eb("visibility_version", "+", 1)` increment pattern
 * publish/unpublish/delete use (architecture.md §5.4).
 *
 * **v1 scope — `deleted_at` clear + version bump only; cascade side-
 * effects deferred.** ADR 0017 §Restore lists search-index rebuild
 * (via `restore_search` queue in `QUEUE_NAMES`), embedding re-
 * activation, and notification no-refire as the restore cascade.
 * None of those backing systems exist in the tree yet; v1 lands the
 * flip + audit emission only. Cascade jobs will enqueue off the
 * existing `outbox` row written by `withAuditTx` when the backing
 * systems land.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId, DocId } from "@editorzero/ids";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_RESTORE_ID = CapabilityId("doc.restore");

// ── Input ────────────────────────────────────────────────────────────────
//
// Mirror of `doc.delete` input: single `doc_id` validated as UUIDv7
// with the brand applied via `.transform(DocId)`. Regex-first so the
// brand runs on already-validated input.

const DocIdInput = z
  .uuid({ version: "v7", message: "doc_id must be a UUIDv7" })
  .transform((s): DocId => DocId(s));

const InputSchema = z
  .object({
    doc_id: DocIdInput,
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────
//
// Returns `visibility_version` so the caller can swap their cached
// public-route key. No `restored_at` field — the post-state is
// "not deleted" and callers re-reading via `doc.get` already see
// the fresh `updated_at`; the audit row owns the event timestamp.

const DocIdField = z.string().transform((s): DocId => DocId(s));

const OutputSchema = z.object({
  doc_id: DocIdField,
  visibility_version: z.number(),
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const docRestore: Capability<Input, Output> = {
  id: DOC_RESTORE_ID,
  category: "mutation",
  summary: "Restore a soft-deleted doc to its live state (inverse of doc.delete).",
  input: InputSchema,
  output: OutputSchema,
  requires: ["doc:delete"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.restore",
      doc_id: output.doc_id,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_RESTORE_ID,
      required_scopes: ["doc:delete"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_RESTORE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Single-statement UPDATE + RETURNING. The `deleted_at IS NOT NULL`
    // WHERE gate means already-live rows return zero rows → 404. Same
    // alias-aware `WorkspaceScopingPlugin` posture as delete — cross-
    // workspace targets are invisible. Symmetric to `doc.delete`'s
    // write shape modulo the inverted null check + the `deleted_at:
    // null` assignment.
    const row = await ctx.db
      .updateTable("docs")
      .set((eb) => ({
        deleted_at: null,
        visibility_version: eb("visibility_version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is not", null)
      .returning(["id", "visibility_version"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    return {
      doc_id: row.id,
      visibility_version: row.visibility_version,
    };
  },
};
