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
 *      `ctx.transact`. The `editor.transact(updateBlock | insertBlocks)`
 *      inside `setDocTitle` emits one `doc_updates` row + one
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
 * tx (P3.6b write-path). If `setDocTitle` throws (e.g., BlockNote
 * misconfiguration, unmountable EditorView), the docs UPDATE rolls
 * back too — the in-memory Y.Doc mutation is reverted via
 * `BoundSyncService.rollback` eviction (the next read rehydrates from
 * committed `doc_updates`).
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
 * heading-1 at 0. Keeps BlockNote specifics inside sync (invariant 7's
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
import { CapabilityId, DocId } from "@editorzero/ids";
import { setDocTitle } from "@editorzero/sync";
import type * as Y from "yjs";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_RENAME_ID = CapabilityId("doc.rename");

// ── Input ────────────────────────────────────────────────────────────────
//
// Same `doc_id` + `title` shape as `doc.create`'s title validator. The
// UUIDv7 regex + branded transform mirrors `doc.publish` so a malformed
// id surfaces as a zod `invalid_format` issue (400 via the dispatcher's
// validation audit) before the handler runs.

const DocIdInput = z
  .uuid({ version: "v7", message: "doc_id must be a UUIDv7" })
  .transform((s): DocId => DocId(s));

const InputSchema = z
  .object({
    doc_id: DocIdInput,
    // Same `.trim().min(1)` posture as `doc.create`'s title field —
    // closes the "visually blank title" hole a plain `min(1)` would
    // leave open ("   " trims to "" and fails validation instead of
    // sneaking past).
    title: z.string().trim().min(1, "title must not be empty or whitespace-only"),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────
//
// Returns the post-rename projection so callers don't need a follow-up
// `doc.get`. Includes `updated_at` because row-side stale checks (e.g.,
// UI list refresh) key on it.

const DocIdField = z.string().transform((s): DocId => DocId(s));

const OutputSchema = z.object({
  doc_id: DocIdField,
  title: z.string(),
  slug: z.string(),
  updated_at: z.number(),
});
type Output = z.infer<typeof OutputSchema>;

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

export const docRename: Capability<Input, Output> = {
  id: DOC_RENAME_ID,
  category: "mutation",
  summary: "Rename a doc — updates the title-block heading + the docs.title bridge.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.rename",
      doc_id: output.doc_id,
      title: output.title,
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
