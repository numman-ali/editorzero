/**
 * `doc.unpublish` — clear a doc's publish dimension: `published_slug`
 * and `published_at` both land on NULL (architecture.md §3.5; ADR 0040
 * Step 5; `METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`).
 *
 * Pair of `doc.publish`, and like it ORTHOGONAL to `access_mode` —
 * unpublishing changes who can reach the doc from OUTSIDE the Org,
 * never its read scope inside. Same metadata-only lane: no
 * `ctx.transact`, no Y.Doc touching, no `doc_updates` row. Single
 * UPDATE + RETURNING. Always lands on the not-published state
 * regardless of prior state; `render_version` bumps on every
 * successful call so cache keyed on the version invalidates even when
 * the caller re-asserts an already-unpublished doc (mirror of
 * publish's F5-driven always-bump — version is an invalidation signal,
 * not a change-detector).
 *
 * **The published URL is RELEASED, not parked.** Clearing
 * `published_slug` removes the row from `docs_published_slug_unique`,
 * so another doc may claim the slug. A later re-publish of this doc
 * re-mints (and may get a suffixed variant if the URL was taken) —
 * deliberate: parking URLs forever would let one workspace member
 * squat the namespace.
 *
 * **Scope.** `doc:publish`. Mirrors publish — the same role widening
 * that grants a caller the ability to open a doc publicly also grants
 * them the ability to close it. Splitting publish/unpublish across
 * different scopes would leave a doc stuck public if the original
 * publisher's role was revoked, which is the opposite of what the scope
 * model wants (admins retain the ability to roll back exposure).
 *
 * **Soft-deleted handling.** A `deleted_at IS NOT NULL` doc returns 404
 * (same projection as `doc.publish` / `doc.get`). `doc.soft_delete`
 * already cleared the publish dimension on its way to the trash, so the
 * only visible effect here would be a `render_version` bump with no
 * state transition. 404 is the honest projection.
 *
 * **Audit effect.** `{ kind: "doc.unpublish", doc_id }`. The clear is
 * deterministic (both fields land on NULL), so the effect needs no
 * payload beyond the target; the audit envelope's `created_at` already
 * says when.
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
// branded via `.transform(DocId)`; output pins the unpublished
// post-state via `z.null()` literals so callers don't need a follow-up
// `doc.get`. See `@editorzero/schemas/doc/unpublish` for definitions.

// ── Capability ───────────────────────────────────────────────────────────

export const docUnpublish: Capability<DocUnpublishInput, DocUnpublishOutput> = {
  id: DOC_UNPUBLISH_ID,
  category: "mutation",
  summary: "Unpublish a doc — clear its public URL slug and published_at.",
  input: DocUnpublishInputSchema,
  output: DocUnpublishOutputSchema,
  requires: ["doc:publish"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
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

    // Same single-UPDATE + expression-builder increment shape as the
    // other metadata mutators — single-statement with RETURNING inside
    // the dispatcher's write-path tx keeps the "0 rows = not found"
    // branch atomic with the write.
    const row = await ctx.db
      .updateTable("docs")
      .set((eb) => ({
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

    // `doc.publish_changed` — mirrors the publish-side emit
    // (packages/capabilities/src/doc/publish.ts); null slug/at says
    // "no longer served". Keyed on `render_version` so a forwarder can
    // reject out-of-order rows without coordination. Committed inside
    // the same write-path tx as the UPDATE above.
    ctx.outbox("doc.publish_changed", {
      doc_id: row.id,
      published_slug: null,
      published_at: null,
      render_version: row.render_version,
    });

    return {
      doc_id: row.id,
      published_slug: null,
      published_at: null,
      render_version: row.render_version,
    };
  },
};
