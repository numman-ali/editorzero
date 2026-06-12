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
 * **Audit effect.** `{ kind: "doc.soft_delete", doc_id, deleted_at }`.
 * The effect carries the exact `deleted_at` the handler wrote (the
 * handler's `ctx.now()`, NOT the audit row's own `created_at` — a
 * different clock), so the replay reducer reconstructs the ADR 0017
 * recovery-window anchor precisely (invariant 3a; Codex review HIGH 4).
 * The `soft_` prefix distinguishes this from the future `doc.purge`
 * hard-delete (ADR 0017 §Hard-delete). The capability's *id* stays
 * `doc.delete` (the user-facing verb); the *effect kind* is
 * `doc.soft_delete` (the audit-vocabulary term). That asymmetry is
 * intentional — the capability registry speaks to callers, the audit
 * log speaks to forensic readers who need to distinguish soft from
 * hard deletion.
 *
 * **Render-cache invalidation — `render_version` bumps; the publish
 * dimension CLEARS (ADR 0040 Step 5).** A trashed doc must leave the
 * public site, and a later restore must never surprise-republish — so
 * the soft-delete UPDATE also lands `published_slug`/`published_at` on
 * NULL (releasing the public URL for reuse; the audit trail keeps the
 * old value via the original `doc.publish` effect). Re-exposure after
 * restore is a deliberate, separate `doc.publish`. The
 * public-route contract (architecture.md §3.5/§7) keys its cache on
 * `(workspace_id, doc_id, latest_snapshot_seq, render_version)`
 * and uses the version as its sole invalidation signal for
 * capabilities in this lane (publish / unpublish /
 * block.set_visibility / delete / restore). The handler bumps
 * `render_version` on every successful call, same
 * `eb("render_version", "+", 1)` pattern publish/unpublish use.
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
import { CapabilityId } from "@editorzero/ids";
import {
  type DocDeleteInput,
  DocDeleteInputSchema,
  type DocDeleteOutput,
  DocDeleteOutputSchema,
} from "@editorzero/schemas/doc/delete";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_DELETE_ID = CapabilityId("doc.delete");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocDeleteInputSchema` / `DocDeleteOutputSchema` are the single source
// (ADR 0034), reused verbatim by the API route's `validator` / `resolver`
// so the wire contract has exactly one definition. Input is the same
// single-`doc_id` shape as `doc.get` / `doc.publish` / `doc.unpublish`
// (UUIDv7-validated, `.transform()`-branded, `.strict()`); the output
// echoes `doc_id` and returns `deleted_at` (recovery-window anchor) +
// `render_version` (render-cache invalidation signal). See the
// schema definition in `@editorzero/schemas/doc/delete` and the header
// above for the semantics that shape these.

// ── Capability ───────────────────────────────────────────────────────────

export const docDelete: Capability<DocDeleteInput, DocDeleteOutput> = {
  id: DOC_DELETE_ID,
  category: "mutation",
  summary: "Soft-delete a doc; reversible via doc.restore within the recovery window.",
  input: DocDeleteInputSchema,
  output: DocDeleteOutputSchema,
  requires: ["doc:delete"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.soft_delete",
      doc_id: output.doc_id,
      deleted_at: output.deleted_at,
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
        // Step 5: a trashed doc leaves the public site — clear the
        // publish dimension so restore can't surprise-republish and the
        // public URL is released (see the file header).
        published_slug: null,
        published_at: null,
        render_version: eb("render_version", "+", 1),
        updated_at: now,
      }))
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .returning(["id", "render_version"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    return {
      doc_id: row.id,
      deleted_at: now,
      render_version: row.render_version,
    };
  },
};
