/**
 * `doc.remove_guest` — hard-DELETE a guest edge by its address
 * `(doc_id, subject_kind, subject_id)` (ADR 0040 Step 8; Appendix A
 * row; invariant 5). Metadata-only mutation; `permission:revoke` scope
 * (same L1 coarse scope as `permission.revoke` — the REAL bound is the
 * administer ladder).
 *
 * **Edge-addressed, not grant_id-addressed.** The unique-edge
 * constraint makes the triple THE identity; the lifecycle verb reads
 * "remove this guest from this doc" with no grant-id lookup
 * round-trip. `permission.revoke(grant_id)` stays the forensic by-row
 * verb and REFUSES guest edges (`guest_grant_requires_remove_guest`)
 * — the two lanes never cross.
 *
 * **Works on TRASHED docs** (404 only when the doc row is missing
 * entirely — no `deleted_at` filter; Codex guest-family design review,
 * 2026-06-12). The alternative is a dead-end: `permission.revoke`
 * refuses guest edges, so if this verb also refused trashed docs,
 * guest edges on trash would be IMMORTAL — un-removable offboarding
 * hazards that resurrect with `doc.restore`. Authority is evaluated
 * over the stored placement (`assertCanAdministerDoc` on the row as
 * stored — the `doc.restore` / `permission.revoke`-on-trashed-doc
 * posture). A missing row entirely is the orphan-grant case
 * (`doc.purge` enumerates + hard-deletes grants; a survivor means
 * out-of-band damage) → 404 on the doc, edge stays inert until repair.
 *
 * **Edge dispositions** (Codex SHOULD-FIX — absent and wrong-lane are
 * distinct signals, not one generic failure):
 *   - absent → 404 `not_found` on the grant edge (there is no guest
 *     edge for this subject on this doc).
 *   - exists but `is_guest = 0` → typed `GrantLifecycleConflictError`
 *     (409 `grant_lifecycle_conflict`): standing-backed access is
 *     removed via `permission.revoke`, not this verb.
 *   - `is_guest = 1` → DELETE with RETURNING; zero rows = concurrent
 *     remove won the race → 404 (the edge is already gone; same
 *     honest terminal as `permission.revoke` step 4).
 *
 * **Output = the FULL row preimage**: grants are hard-DELETEd, so this
 * response and its `acl.revoke` audit row are the only durable record
 * of what access was removed.
 *
 * **Subject.** The DOC (mirror of `doc.add_guest` — the pair reads
 * "shared / unshared" on the same subject); the removed grantee is in
 * the effect payload.
 */

import type { AuditDeny, AuditEffect, DenyReason, HandlerError } from "@editorzero/audit";
import { GrantLifecycleConflictError, NotFoundError } from "@editorzero/errors";
import { CapabilityId } from "@editorzero/ids";
import {
  type DocRemoveGuestInput,
  DocRemoveGuestInputSchema,
  type DocRemoveGuestOutput,
  DocRemoveGuestOutputSchema,
} from "@editorzero/schemas/doc/remove_guest";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_REMOVE_GUEST_ID = CapabilityId("doc.remove_guest");

const GRANT_ROW_COLUMNS = [
  "id",
  "workspace_id",
  "resource_kind",
  "resource_id",
  "subject_kind",
  "subject_id",
  "role",
  "is_guest",
  "created_by",
  "created_at",
] as const;

interface GrantRow {
  readonly id: DocRemoveGuestOutput["grant_id"];
  readonly workspace_id: DocRemoveGuestOutput["workspace_id"];
  readonly resource_kind: DocRemoveGuestOutput["resource_kind"];
  readonly resource_id: string;
  readonly subject_kind: DocRemoveGuestOutput["subject_kind"];
  readonly subject_id: string;
  readonly role: DocRemoveGuestOutput["role"];
  readonly is_guest: DocRemoveGuestOutput["is_guest"];
  readonly created_by: DocRemoveGuestOutput["created_by"];
  readonly created_at: number;
}

function toOutput(row: GrantRow): DocRemoveGuestOutput {
  return {
    grant_id: row.id,
    workspace_id: row.workspace_id,
    resource_kind: row.resource_kind,
    resource_id: row.resource_id,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    role: row.role,
    is_guest: row.is_guest,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

// ── Capability ───────────────────────────────────────────────────────────

export const docRemoveGuest: Capability<DocRemoveGuestInput, DocRemoveGuestOutput> = {
  id: DOC_REMOVE_GUEST_ID,
  category: "mutation",
  summary: "Hard-delete a guest edge by (doc, subject) address; echoes the full preimage.",
  input: DocRemoveGuestInputSchema,
  output: DocRemoveGuestOutputSchema,
  requires: ["permission:revoke"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({
      kind: "doc",
      id: input.doc_id,
    }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "acl.revoke",
      grant_id: output.grant_id,
      workspace_id: output.workspace_id,
      resource_kind: output.resource_kind,
      resource_id: output.resource_id,
      subject_kind: output.subject_kind,
      subject_id: output.subject_id,
      role: output.role,
      is_guest: output.is_guest,
      created_by: output.created_by,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_REMOVE_GUEST_ID,
      required_scopes: ["permission:revoke"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError) => projectErrorAudit(DOC_REMOVE_GUEST_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    // Step 1 — the doc row, trashed-or-live (NO deleted_at filter; see
    // header — refusing trash would make guest edges on trash immortal).
    const acl = await loadDocReadResolver(ctx.db, ctx.principal);
    const doc = await ctx.db
      .selectFrom("docs")
      .select(["id", "created_by", "access_mode", "collection_id"])
      .where("id", "=", input.doc_id)
      .executeTakeFirst();
    if (doc === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // Step 2 — administer authority over the STORED placement (the
    // doc.restore posture; on trash this is offboarding, not access).
    acl.assertCanAdministerDoc(doc);

    // Step 3 — the edge, by address.
    const existing = await ctx.db
      .selectFrom("grants")
      .select(GRANT_ROW_COLUMNS)
      .where("resource_kind", "=", "doc")
      .where("resource_id", "=", input.doc_id)
      .where("subject_kind", "=", input.subject_kind)
      .where("subject_id", "=", input.subject_id)
      .executeTakeFirst();

    if (existing === undefined) {
      throw new NotFoundError({
        subject_kind: "grant",
        subject_id: input.subject_id,
        message:
          `doc.remove_guest: no guest edge exists for ${input.subject_kind} ` +
          `${input.subject_id} on doc ${input.doc_id}`,
      });
    }

    if (existing.is_guest === 0) {
      throw new GrantLifecycleConflictError({
        message:
          "doc.remove_guest: this edge is a NON-guest grant (standing-backed " +
          "access); remove it via permission.revoke — this verb only manages " +
          "the is_guest = 1 lifecycle.",
        existing_lane: "non_guest",
        grant_id: existing.id,
      });
    }

    // Step 4 — hard DELETE; RETURNING is the authoritative preimage.
    // No verb ever flips is_guest in place (grant/add_guest both throw
    // lifecycle conflicts instead), so the id checked above can only
    // have been deleted — not re-laned — by a concurrent writer.
    const deleted = await ctx.db
      .deleteFrom("grants")
      .where("id", "=", existing.id)
      .returning(GRANT_ROW_COLUMNS)
      .executeTakeFirst();
    if (deleted === undefined) {
      // Concurrent remove won between step 3 and here — the edge is
      // already gone. 404 keeps the terminal state honest.
      throw new NotFoundError({ subject_kind: "grant", subject_id: existing.id });
    }
    return toOutput(deleted);
  },
};
