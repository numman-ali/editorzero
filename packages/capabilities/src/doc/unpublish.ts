/**
 * `doc.unpublish` — set a doc's `visibility` back to `"workspace"`
 * (architecture.md Appendix A § doc; `METADATA_ONLY_CAPABILITIES` in
 * `@editorzero/scopes`).
 *
 * Pair of `doc.publish`. Same metadata-only lane: no `ctx.transact`, no
 * Y.Doc touching, no `doc_updates` row. Single UPDATE + RETURNING on
 * the `docs` row. Always lands on `visibility: "workspace"` regardless
 * of prior state; `visibility_version` bumps on every successful call
 * so cache keyed on the version invalidates even when the caller re-
 * asserts an already-unpublished state (mirror of publish's F5-driven
 * always-bump — version is an invalidation signal, not a change-
 * detector).
 *
 * **"Workspace" as the unpublish target, not "private".** The matrix
 * has three visibility states (workspace / public / private), but
 * unpublish doesn't need a caller-chosen target: `"workspace"` is the
 * default new-doc visibility (see `doc/create.ts` → `DEFAULT_VISIBILITY`)
 * and the "not public" state that a later public-route renderer will
 * treat as un-listed. A caller who wants `"private"` uses a future
 * `doc.set_visibility` (not yet implemented); `doc.unpublish` is the
 * narrow inverse of `doc.publish`, intentionally symmetric.
 *
 * **Scope.** `doc:publish`. Mirrors publish — the same role widening
 * that grants a caller the ability to open a doc publicly also grants
 * them the ability to close it. Splitting publish/unpublish across
 * different scopes would leave a doc stuck public if the original
 * publisher's role was revoked, which is the opposite of what the scope
 * model wants (admins retain the ability to roll back visibility).
 *
 * **Soft-deleted handling.** A `deleted_at IS NOT NULL` doc returns 404
 * (same projection as `doc.publish` / `doc.get`). Unpublishing a
 * trashed doc has no defined meaning; the soft-deleted state already
 * hides it from the public-route by construction, so the only visible
 * effect would be a `visibility_version` bump with no corresponding
 * state transition. 404 is the honest projection.
 *
 * **Audit effect.** `{ kind: "doc.unpublish", doc_id }`. No timestamp
 * field on the effect — `doc.publish` carries `published_at` because
 * the target DDL persists it on the `docs` row (deferred; see
 * `doc/publish.ts` v1 scope note), but the un-publish side has no
 * symmetric `unpublished_at` in the architecture.md target DDL. The
 * audit row's `created_at` envelope already carries "when this
 * happened"; no separate effect field needed.
 *
 * **v1 scope — visibility-only slice; `published_slug` clearing
 * deferred.** Matches the `doc.publish` scope note: the target DDL
 * has `published_slug` clearing happen on `doc.unpublish`
 * (architecture.md §3.5 "cleared on doc.unpublish"), but the column
 * doesn't exist in the live schema yet. When the public-route renderer
 * slice ships `published_slug` + `published_at`, this handler's UPDATE
 * grows to also set `published_slug = null`. Additive migration — no
 * wire-contract change, no response-shape change.
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
  type DocUnpublishInput,
  DocUnpublishInputSchema,
  type DocUnpublishOutput,
  DocUnpublishOutputSchema,
} from "@editorzero/schemas/doc/unpublish";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_UNPUBLISH_ID = CapabilityId("doc.unpublish");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocUnpublishInputSchema` / `DocUnpublishOutputSchema` are the single
// source (ADR 0034), reused verbatim by the API route's `validator` /
// `resolver`. Input is a single `doc_id` validated as a UUIDv7 then
// branded via `.transform(DocId)`; output returns the post-update
// projection (`visibility` pinned to the literal `"workspace"`) so
// callers don't need a follow-up `doc.get`. See
// `@editorzero/schemas/doc/unpublish` for the definitions.

// ── Capability ───────────────────────────────────────────────────────────

export const docUnpublish: Capability<DocUnpublishInput, DocUnpublishOutput> = {
  id: DOC_UNPUBLISH_ID,
  category: "mutation",
  summary: "Set a doc's visibility back to workspace (inverse of doc.publish).",
  input: DocUnpublishInputSchema,
  output: DocUnpublishOutputSchema,
  requires: ["doc:publish"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.unpublish",
      doc_id: output.doc_id,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_UNPUBLISH_ID,
      required_scopes: ["doc:publish"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_UNPUBLISH_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Same single-UPDATE + expression-builder increment shape as
    // `doc.publish` — see that file's handler comment for why this
    // runs single-statement with RETURNING inside the dispatcher's
    // BEGIN IMMEDIATE tx.
    const row = await ctx.db
      .updateTable("docs")
      .set((eb) => ({
        visibility: "workspace",
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

    // `doc.visibility_changed` — mirrors the publish-side emit
    // (packages/capabilities/src/doc/publish.ts). Same event
    // name; the `visibility` discriminator tells the downstream
    // forwarder which side flipped. Committed inside the same
    // write-path tx as the UPDATE above (architecture.md §2101).
    ctx.outbox("doc.visibility_changed", {
      doc_id: row.id,
      visibility: "workspace",
      visibility_version: row.visibility_version,
    });

    return {
      doc_id: row.id,
      visibility: "workspace",
      visibility_version: row.visibility_version,
    };
  },
};
