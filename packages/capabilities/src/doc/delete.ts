/**
 * `doc.delete` — soft-delete a doc (ADR 0017; `METADATA_ONLY_CAPABILITIES`
 * in `@editorzero/scopes`; AGENTS.md invariant 6).
 *
 * Metadata-only mutation: no `ctx.transact`, no Y.Doc touching, no
 * `doc_updates` row. Single UPDATE on the `docs` row that flips
 * `deleted_at` from NULL to `ctx.now()`. ADR 0017 §"What gets
 * soft-deleted" codifies the cascade — blocks + `doc_updates` +
 * `doc_snapshots` are **preserved as-is** so `doc.restore` can bring
 * the doc back bit-identical modulo `audit_events` (the inverse-
 * restore property test, P3 harness).
 *
 * **Scope.** `doc:delete`. Same scope covers `doc.restore` (symmetry
 * with publish/unpublish — the principal who can delete must retain
 * rollback). Splitting delete/restore across distinct scopes would
 * leave a doc stuck in trash if the original deleter's role was
 * revoked — the opposite of what the scope model wants.
 *
 * **Already-deleted handling.** A `deleted_at IS NOT NULL` doc returns
 * 404. This is the honest projection: idempotent *state* arrival is
 * not the same as an idempotent *operation*, and re-deleting a
 * trashed doc would imply overwriting the prior `deleted_at`
 * timestamp (which ADR 0017's 30-day recovery window anchors to).
 * Collapsing delete-on-already-deleted to a silent no-op would mean
 * silently sliding that recovery window on every retried call — a
 * durability regression we don't want. Callers observing 404 on a
 * retry already have the confirmation "this is trashed".
 *
 * **Audit effect.** `{ kind: "doc.soft_delete", doc_id }`. The
 * audit-effect union carries no `deleted_at` field (the audit row's
 * own `created_at` envelope is authoritative for when); the `soft_`
 * prefix distinguishes this from the future `doc.purge` hard-delete
 * (ADR 0017 §Hard-delete). The capability's *id* stays `doc.delete`
 * (the user-facing verb); the *effect kind* is `doc.soft_delete` (the
 * audit-vocabulary term). That asymmetry is intentional — the
 * capability registry speaks to callers, the audit log speaks to
 * forensic readers who need to distinguish soft from hard deletion.
 *
 * **Public-route cache invalidation — `visibility_version` bumps.** The
 * public-route contract (architecture.md §5.4) keys its cache on
 * `(workspace_id, doc_id, latest_snapshot_seq, visibility_version)`
 * and uses the version as its sole invalidation signal for
 * capabilities in this lane (publish / unpublish /
 * block.set_visibility / delete / restore). A soft-delete of
 * a *published* doc must flip the public-route from "renders" to
 * "404" — without a version bump, a cached render would keep serving
 * a deleted-but-published doc. The handler therefore bumps
 * `visibility_version` on every successful call, same
 * `eb("visibility_version", "+", 1)` pattern publish/unpublish use.
 * Idempotent semantics: the version moves even though `deleted_at`
 * would trivially overwrite itself, so any cache keyed on the version
 * invalidates even if an unusual caller replays delete on a fresh
 * doc (the 404-on-already-deleted branch short-circuits this in
 * practice).
 *
 * **v1 scope — `deleted_at` flip + version bump only; cascade side-effects deferred.**
 * ADR 0017 lists search-index removal, embedding deactivation, and
 * notification cancellation as part of the delete cascade. None of
 * those systems exist in the tree yet (search index, embeddings,
 * notifications are post-Phase-3). The v1 handler lands the flip +
 * the audit emission only; cascade side-effects attach as post-
 * commit jobs (`search_reindex`, `dcr_cleanup`, etc. are already
 * reserved in `packages/scopes` → `QUEUE_NAMES`) when the backing
 * systems land. No handler logic from this file is load-bearing for
 * that transition — cascade jobs enqueue off the existing `outbox`
 * row emitted by `withAuditTx`, which v1 already writes.
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

const DOC_DELETE_ID = CapabilityId("doc.delete");

// ── Input ────────────────────────────────────────────────────────────────
//
// Same shape as `doc.get` / `doc.publish` / `doc.unpublish`: a single
// `doc_id` validated as a UUIDv7 with the brand applied via
// `.transform(DocId)`. Regex-first so the brand runs on already-
// validated input.

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
// Returns `deleted_at` so the caller can confirm the recovery-window
// anchor point without a follow-up `doc.get`. `doc_id` echoes the
// input id for client convenience.

const DocIdField = z.string().transform((s): DocId => DocId(s));

const OutputSchema = z.object({
  doc_id: DocIdField,
  deleted_at: z.number(),
  visibility_version: z.number(),
});
type Output = z.infer<typeof OutputSchema>;

// ── Capability ───────────────────────────────────────────────────────────

export const docDelete: Capability<Input, Output> = {
  id: DOC_DELETE_ID,
  category: "mutation",
  summary: "Soft-delete a doc; reversible via doc.restore within the recovery window.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["doc:delete"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.soft_delete",
      doc_id: output.doc_id,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_DELETE_ID,
      required_scopes: ["doc:delete"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_DELETE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Single-statement UPDATE + RETURNING inside the dispatcher's
    // `BEGIN IMMEDIATE`. The `deleted_at IS NULL` WHERE gate guarantees
    // already-deleted rows return zero rows → the handler throws 404
    // (honest-projection, see doc-block above). The
    // `WorkspaceScopingPlugin` appends `workspace_id = ctx.tenant.*`
    // on UPDATE + RETURNING (F87 alias-aware), so cross-workspace
    // targets are invisible — same 404.
    const row = await ctx.db
      .updateTable("docs")
      .set((eb) => ({
        deleted_at: now,
        visibility_version: eb("visibility_version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .returning(["id", "visibility_version"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    return {
      doc_id: row.id,
      deleted_at: now,
      visibility_version: row.visibility_version,
    };
  },
};
