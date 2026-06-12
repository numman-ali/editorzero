/**
 * `doc.rename` — rename a doc via the title-slot rule + a metadata
 * bridge write (architecture.md §6.5 / §16.5, ADR 0018).
 *
 * **Not metadata-only.** `doc.rename` is deliberately excluded from
 * `METADATA_ONLY_CAPABILITIES` (see `packages/scopes/src/index.ts` F54
 * comment): the title lives in the heading-1 block at document index 0,
 * and mutating it means threading through `ctx.transact` + the live
 * editor. Content mutation, same lane as any future `doc.update`.
 *
 * **Dual-write during v1.** The handler writes in two places inside
 * the dispatcher's write-path tx:
 *
 *   1. `docs.title` + `docs.updated_at` — UPDATE first, with RETURNING
 *      so a missing or soft-deleted row surfaces as 404 before the
 *      CRDT mutation runs. `doc.list` / `doc.get` project `docs.title`
 *      directly today (no title-projection job yet), so the row-side
 *      value has to match the block-side value or list views go stale.
 *   2. The Y.Doc's title block — via `setDocTitle` through
 *      `ctx.transact`. The single `writeBlocks` Yjs transaction inside
 *      `setDocTitle` (ADR 0038) emits one `doc_updates` row + one
 *      `outbox(doc.updated)` — no additional `ctx.outbox(...)` call is
 *      needed from the handler; the CRDT-mutation seam already emits
 *      that event.
 *
 * The bridge is temporary. A follow-on title-projection job (future
 * slice) will derive `docs.title` from `doc_updates` via the replay
 * path so the handler shrinks to just the `ctx.transact` call. Until
 * that lands, this double-write is what keeps row-side reads coherent.
 *
 * **Atomicity.** Both writes land inside the dispatcher's single SQL
 * tx (P3.6b write-path). If `setDocTitle` throws (corrupted fragment,
 * schema mismatch), the docs UPDATE rolls back too — the in-memory
 * Y.Doc mutation is reverted via `BoundSyncService.rollback` eviction
 * (the next read rehydrates from committed `doc_updates`).
 *
 * **Order-of-writes.** UPDATE first, `ctx.transact` second — same
 * reasoning as `doc.create` (Codex P3.6c adversarial P3). A missing
 * `docs` row is the 404 short-circuit; running `ctx.transact` against
 * a missing doc would auto-bootstrap `doc_counters` + write a
 * `doc_updates` row whose FK to `docs(id)` doesn't exist, failing at
 * SQL. UPDATE-first makes the 404 explicit and keeps SQL clean.
 *
 * **Slug follows title.** `doc.create`'s `slugify` is the v1 derivation
 * and `doc.rename` mirrors it for consistency. Callers that want stable
 * public-route URLs independent of title should use a future
 * `doc.set_slug` capability; until that lands, the pragmatic choice is
 * "slug tracks title" so listings and URLs don't diverge. Empty slug
 * (title is all-punctuation / emoji) falls back to `"untitled"` — the
 * `docs.slug` NOT NULL constraint is the guardrail.
 *
 * **Title-slot rule.** Encapsulated in `@editorzero/sync`'s
 * `setDocTitle`: block 0 heading-1 → update in place; otherwise insert
 * heading-1 at 0. Keeps Y.Doc specifics inside sync (invariant 7's
 * `no-raw-ydoc-access` coherence rule policies capability-side).
 *
 * **Scope.** `doc:write` — the same gate as `doc.create` and the future
 * `doc.update`. Members, admins, and owners hold it; guests don't.
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
  type DocRenameInput,
  DocRenameInputSchema,
  type DocRenameOutput,
  DocRenameOutputSchema,
} from "@editorzero/schemas/doc/rename";
import { setDocTitle } from "@editorzero/sync";
import type * as Y from "yjs";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_RENAME_ID = CapabilityId("doc.rename");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `DocRenameInputSchema` / `DocRenameOutputSchema` are the single source
// (ADR 0034), reused verbatim by the API route's `validator` / `resolver`.
// The `doc_id` + `title` shape mirrors `doc.create`'s title validator; a
// malformed id surfaces as a zod issue (400 via the dispatcher's validation
// audit) before the handler runs. The output returns the post-rename
// projection (incl. `updated_at`, which row-side stale checks key on) so
// callers don't need a follow-up `doc.get`. Definitions + rationale live in
// `@editorzero/schemas/doc/rename`.

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Kebab-case the title; empty output becomes `"untitled"` so the
 * `docs.slug` NOT NULL constraint never trips. Mirror of
 * `doc.create`'s slugify — kept duplicated (not imported) so the two
 * capabilities' slug derivation stays visibly coupled and a future
 * divergence (e.g., rename wanting stable slugs) is a one-file change.
 */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "untitled";
}

// ── Capability ───────────────────────────────────────────────────────────

export const docRename: Capability<DocRenameInput, DocRenameOutput> = {
  id: DOC_RENAME_ID,
  category: "mutation",
  summary: "Rename a doc — updates the title-block heading + the docs.title bridge.",
  input: DocRenameInputSchema,
  output: DocRenameOutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.rename",
      doc_id: output.doc_id,
      title: output.title,
      // The handler re-derived this from the new title and wrote it to
      // `docs.slug` in the same UPDATE; carry it so replay reconstructs the
      // slug instead of retaining the stale create-time value (the effect must
      // carry every handler-computed field the projection reads).
      slug: output.slug,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_RENAME_ID,
      required_scopes: ["doc:write"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_RENAME_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();
    const title = input.title;
    const slug = slugify(title);

    // Step 1 — UPDATE docs row first. The WorkspaceScopingPlugin
    // injects `workspace_id = ctx.tenant.workspace_id` on the
    // statement so a cross-workspace target returns zero rows from
    // `.returning(...)` and the handler 404s — same cross-tenant
    // invisibility `doc.publish` gets. Soft-deleted docs filter out
    // via the `deleted_at IS NULL` guard; rename on a trashed doc is
    // 404 (callers use `doc.restore` first).
    const row = await ctx.db
      .updateTable("docs")
      .set({ title, slug, updated_at: now })
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .returning(["id", "title", "slug", "updated_at"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // Step 2 — CRDT mutation via the sync-owned title-slot rule.
    // Kernel's `TEditor` is still `unknown` (kernel.ts header); the
    // single documented cast narrows to Y.Doc here, same dance
    // `doc.create` uses.
    await ctx.transact(input.doc_id, async (editor) => {
      await setDocTitle(editor as Y.Doc, title);
    });

    return {
      doc_id: row.id,
      title: row.title,
      slug: row.slug,
      updated_at: row.updated_at,
    };
  },
};
