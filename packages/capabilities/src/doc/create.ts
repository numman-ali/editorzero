/**
 * `doc.create` — create a new document in the caller's workspace
 * (architecture.md Appendix A § doc, §8.4 contract matrix, ADR 0018).
 *
 * Semantics:
 *   1. Mint a fresh UUIDv7 `doc_id`.
 *   2. INSERT the `docs` row through `ctx.db` — tenant scoping forces
 *      `workspace_id` to match the caller's scope (invariant 5).
 *   3. Seed the Y.Doc via `ctx.transact` (invariant 7 + ADR 0018): a
 *      `heading/1` with the title text, followed by an empty
 *      `paragraph` — the canonical BlockNote "new doc" shape.
 *
 * The seed step goes through `ctx.transact` rather than a raw
 * `SyncService.transact` call because that is what the invariant 7
 * arch-lint rule (F89; today the coherence script's
 * `no-raw-ydoc-access`) polices. The capability never imports Y.Doc /
 * Y.XmlFragment directly; `@editorzero/sync`'s `seedBlocks` owns the
 * CRDT contact.
 *
 * The runtime `ctx.transact` is wired to `@editorzero/sync`'s
 * `MemorySyncService.transact(doc_id, fn)` today (later:
 * Hocuspocus-backed) — the callback receives a `Y.Doc`. At the kernel
 * level `TEditor` is still `unknown` (kernel comment: "sharpened when
 * handler code is written"); the handler narrows with a single
 * documented cast inside the callback. A later sub-slice that
 * introduces a registry-wide `TEditor=Y.Doc` (or a richer
 * editor-bundle wrapper for `doc.update`'s BlockNoteEditor path) will
 * drop the cast without rewriting the handler body.
 *
 * Slug derivation is intentionally naive in v1 (kebab-case of title,
 * empty → "untitled"). Collision handling is a future concern — the
 * `docs` table has no uniqueness constraint on `(workspace_id, slug)`
 * today; if we add one, a retry-on-conflict loop lands here, not in
 * the SQL layer.
 *
 * **v1 limitations.** Two input fields a v2 `doc.create` will
 * accept are intentionally absent today, for symmetric
 * "don't-promise-what-we-can't-enforce" reasons:
 *
 *   - `collection_id` — no `collections` table / FK target yet in
 *     the DDL, so accepting a caller-supplied id would write a
 *     dangling reference. New docs always land at workspace root
 *     (`collection_id: null`); `doc.move` owns placement once
 *     `collections` ships with DDL + FK.
 *   - `visibility` — `doc.list` returns every non-deleted doc in
 *     the workspace regardless of `visibility` today (no per-doc
 *     visibility filter / ACL table). Accepting `"private"` would
 *     print a label the read path doesn't honour (false privacy);
 *     accepting `"public"` would bypass `doc:publish`. New docs
 *     land as `"workspace"`; `doc.publish` (scope `doc:publish`)
 *     and a future visibility-widening capability open the other
 *     states once the read path is ready.
 *
 * `InputSchema.strict()` makes either attempt a zod
 * `unrecognized_keys` issue — a 400 with a clear path reference,
 * not a silent drop.
 *
 * **Title normalisation.** `z.string().trim().min(1)` strips
 * surrounding whitespace before the non-empty check. `"   "` trims
 * to `""` and fails validation; `"  Hello  "` stores as `"Hello"`.
 * Closes the "visually blank title" hole a plain `min(1)` would
 * leave open.
 *
 * `order_key` is initialised to `doc_id`. UUIDv7's time-sortability
 * gives single-process append order for free; multi-replica
 * deployments need a cross-process counter (tracked inline at the
 * assignment site) and will swap the scheme when that infra lands.
 * A fractional-index rewrite lands when drag-to-reorder ships (out
 * of scope for P3.5).
 *
 * `created_by` typing: `DocsTable.created_by` is `UserId`. A human
 * principal contributes `principal.id`. An agent principal contributes
 * either its `acting_as` (delegated agent-auth token) or its owner's
 * `owner_user_id`.
 *
 * **v1 limitation — workspace-owned agents.** `AgentPrincipal` allows
 * `owner_user_id: null` for workspace-owned automations (platform
 * bots without a specific owner). Those principals cannot satisfy
 * `docs.created_by: UserId` today; the handler refuses them with a
 * `ValidationError` (400-class, typed audit row — not a server
 * error). The capability matrix advertises `agentAllowed: {}` because
 * typical agents (owner-scoped or `acting_as`-delegated) work fine;
 * the workspace-owned case needs `docs.created_by` to widen to
 * `UserId | AgentId` (schema refresh + ADR 0016 followup) before
 * `agentAllowed` becomes unconditional.
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
  SeedBlock,
} from "@editorzero/audit";
import { ValidationError } from "@editorzero/errors";
import {
  BlockId,
  CapabilityId,
  CollectionId,
  DocId,
  generateBlockId,
  generateDocId,
  WorkspaceId,
} from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import { type LoosePartialBlock, seedBlocks } from "@editorzero/sync";
import type * as Y from "yjs";
import { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_CREATE_ID = CapabilityId("doc.create");
const DEFAULT_VISIBILITY = "workspace" as const;

// ── Input ────────────────────────────────────────────────────────────────
//
// Input is intentionally minimal: `{ title }`. Two other obvious
// fields — `visibility` and `collection_id` — are deliberately not
// accepted today because the surrounding machinery can't honour
// them without regressing on stronger guarantees. Callers that try
// to set either get a zod `unrecognized_keys` issue via
// `InputSchema.strict()`, which surfaces as a 400 at the dispatcher
// (not a silent drop). The rationale per-field:
//
//   • `visibility` — v1 ships with no per-doc visibility enforcement
//     on the read path. `doc.list` returns every non-deleted doc in
//     the workspace regardless of `visibility` (no ACL table yet,
//     no per-doc-visibility filter). Accepting `"private"` or
//     `"public"` on create would print a visibility label on the
//     row that the read path doesn't honour — a *false privacy
//     guarantee* for `"private"`, and a `doc:publish`-scope bypass
//     for `"public"` (members hold `doc:write` but not
//     `doc:publish`, so a caller could mint a public doc through
//     `doc.create` and skip the dedicated publish permission +
//     audit row). New docs land as `visibility: "workspace"`; when
//     the read path honours visibility, `doc.publish` (scope
//     `doc:publish`) opens the public path and a future
//     `doc.set_visibility` (or widening here) opens the private
//     path.
//
//   • `collection_id` — v1 has no `collections` table / FK target
//     yet (`docs.collection_id` is a nullable column, no REFERENCES
//     clause in `DOCS_DDL`). Accepting a caller-supplied id would
//     write a dangling reference; validating that "the collection
//     exists and belongs to this workspace" requires a SELECT
//     against a table that can't exist yet. New docs always land at
//     workspace root (`collection_id: null`); `doc.move` (future
//     slice, once `collections` ships with DDL + FK) owns the
//     placement transition.
//
// `VisibilitySchema` below is the OUTPUT-side enum — it stays
// `{"workspace", "private"}` today so the audit effect remains
// assignable to the wider `DocVisibility` type and so widening the
// read-path later only requires widening the input, not rewriting
// the output/audit contract.

const VisibilitySchema = z.enum(["workspace", "private"]);

const InputSchema = z
  .object({
    // `.trim()` first so a title like `"  Hello  "` stores as
    // `"Hello"` — leading/trailing whitespace is meaningless and
    // would otherwise render as visually indented. `.min(1)` after
    // the trim closes the "whitespace-only title" hole: `"   "`
    // trims to `""` and fails validation instead of sneaking past
    // as a non-empty string while producing a blank heading.
    title: z.string().trim().min(1, "title must not be empty or whitespace-only"),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

// ── Output ───────────────────────────────────────────────────────────────
//
// `workspace_id` is redundant with `ctx.tenant.workspace_id` but lives
// on the output because `audit.effectOnAllow` has no ctx access — the
// `doc.create` audit kind requires it. Callers that don't want it can
// ignore it; the cost of an extra 36-char field on the response is
// cheaper than a separate audit-context plumbing.

const DocIdField = z.string().transform((s): DocId => DocId(s));
const WorkspaceIdField = z.string().transform((s): WorkspaceId => WorkspaceId(s));
const NullableCollectionIdField = z
  .string()
  .nullable()
  .transform((s): CollectionId | null => (s === null ? null : CollectionId(s)));

// `seed_blocks` — the pre-minted block IDs + shape the handler passed
// into `seedBlocks`. Lives on the output so `effectOnAllow` can project
// it into the audit effect (same pattern as `workspace_id` above: the
// audit projection has no ctx access, so handler-derived data lands on
// output). Agent callers get an ergonomic byproduct — they can apply a
// follow-up `doc.update` against these IDs without a refetch.
const BlockIdField = z.string().transform((s): BlockId => BlockId(s));
const SeedBlockSchema = z.object({
  id: BlockIdField,
  type: z.string(),
  props: z.record(z.string(), z.unknown()).optional(),
  content: z.unknown().optional(),
});

const OutputSchema = z.object({
  doc_id: DocIdField,
  workspace_id: WorkspaceIdField,
  collection_id: NullableCollectionIdField,
  title: z.string(),
  slug: z.string(),
  order_key: z.string(),
  visibility: VisibilitySchema,
  seed_blocks: z.array(SeedBlockSchema),
});
type Output = z.infer<typeof OutputSchema>;

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Kebab-case the title; empty output becomes `"untitled"` so `docs.slug`'s
 * NOT NULL constraint never trips. Not collision-safe (see file header).
 */
function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "untitled";
}

/**
 * Resolve the `UserId` that will land in `docs.created_by`.
 *
 * A workspace-owned agent (`owner_user_id === null` without `acting_as`)
 * is a supported principal shape but can't satisfy the `docs.created_by:
 * UserId` schema today. Rather than throw a raw `Error` — which the
 * dispatcher would project to `{ kind: "internal" }` and audit as a 500
 * (F95) — the refusal surfaces as a typed `ValidationError`. That maps
 * to `httpStatus: 400` and a structured `{ kind: "validation" }` audit
 * row, which is an honest read of the situation: the principal shape
 * doesn't meet the capability's current preconditions, and a delegated
 * agent-auth token would let the same caller succeed.
 */
function resolveCreatedBy(principal: Principal) {
  if (principal.kind === "user") return principal.id;
  if (principal.acting_as !== undefined) return principal.acting_as;
  if (principal.owner_user_id !== null) return principal.owner_user_id;
  throw new ValidationError({
    message:
      "doc.create: agent principal has neither `acting_as` nor `owner_user_id` set; " +
      "cannot attribute `docs.created_by` to a human in v1.",
    issues: [
      {
        code: "unattributable_agent",
        message:
          "workspace-owned agent principal requires a delegated `acting_as` " +
          "(agent-auth token) or a non-null `owner_user_id` for doc.create",
        path: ["principal"],
      },
    ],
  });
}

// ── Capability ───────────────────────────────────────────────────────────

export const docCreate: Capability<Input, Output> = {
  id: DOC_CREATE_ID,
  category: "mutation",
  summary: "Create a new document in the caller's workspace; seeds the Y.Doc with a title block.",
  input: InputSchema,
  output: OutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (_input) => ({ kind: "doc" }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.create",
      doc_id: output.doc_id,
      workspace_id: output.workspace_id,
      collection_id: output.collection_id,
      title: output.title,
      slug: output.slug,
      order_key: output.order_key,
      visibility: output.visibility,
      seed_blocks: output.seed_blocks,
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_CREATE_ID,
      required_scopes: ["doc:write"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_CREATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const doc_id = generateDocId();
    const workspace_id = ctx.tenant.workspace_id;
    // v1 always lands docs at workspace root; `collections` table and
    // `doc.move` ship in a later slice (see input comment).
    const collection_id: CollectionId | null = null;
    const title = input.title;
    const slug = slugify(title);
    // `order_key = doc_id` is a **single-replica** append guarantee.
    // `uuidV7()` encodes a monotonic 12-bit counter in `rand_a` that
    // is **per-process**; two replicas minting in the same ms can
    // produce IDs whose lexicographic order disagrees with real-time
    // creation order. In the current OSS single-node default (one
    // writer + SQLite or one Postgres + one app replica) this is
    // correct — there is only ever one minting process. Multi-
    // replica deployments land with architecture.md § 3.5's
    // fractional-index scheme (or a `doc_counters` seq parallel to
    // the one `doc_updates` uses) — at which point this line becomes
    // a seq draw from a cross-replica counter, not `doc_id`. Codex
    // F103 P3 — documented, not fixed, because the fix requires
    // infra the slice doesn't ship yet.
    const order_key = doc_id;
    const visibility = DEFAULT_VISIBILITY;
    const now = ctx.now();
    const created_by = resolveCreatedBy(ctx.principal);

    // Order-of-writes: INSERT the docs row FIRST, then seed the CRDT.
    //
    // This ordering is what the unified write-path tx (P3.6b) plus the
    // Hocuspocus-backed sync service (P3.6c) require. The
    // `DocUpdatesWriter` that `ctx.transact` calls through persists
    // `doc_updates` + `outbox(doc.updated)` + an auto-bootstrapped
    // `doc_counters` row — all of which carry foreign keys back to
    // `docs(id)`. With the docs row absent at `ctx.transact` time, the
    // FK on `doc_counters.doc_id` (auto-bootstrap INSERT) or on
    // `doc_updates(doc_id, workspace_id)` (the update row itself) would
    // fail before any partial state can land.
    //
    // Closes Codex P3.6c adversarial P3: the previous "seed-first,
    // insert-second" ordering — safe when `MemorySyncService` was the
    // only backend and `ctx.transact` never touched SQL — becomes
    // incompatible with the Hocuspocus-backed writer. Flipping the
    // order is safe under the P3.6b write-path tx because both writes
    // now live in the same `BEGIN IMMEDIATE` region: any failure
    // between them rolls back both rows. No visible-ghost-doc risk,
    // no orphan Y.Doc risk (rollback abandons the in-memory mutation;
    // P3.6e wires `onLoadDocument` so a subsequent read rehydrates
    // cleanly from `doc_updates`).
    //
    // Kernel `TEditor` is `unknown` today (kernel.ts header); the
    // runtime ctx.transact hands us the Y.Doc that `@editorzero/sync`
    // mints — a single documented cast here is what we pay until the
    // registry's `TEditor` sharpens. `seedBlocks` itself polices the
    // Y.Doc; this file never imports `Y.XmlFragment`.
    //
    // The `as unknown as LoosePartialBlock[]` follows the pattern
    // `packages/sync/src/blocks.unit.test.ts` uses: BlockNote's
    // concrete per-type block configs don't match the wide-generic
    // `LoosePartialBlock` literal-for-literal, so the sync boundary
    // is by convention cast at the call site.
    //
    // **Pre-minted block IDs (closes Codex F104 P1 / gap (b)).** We mint
    // `BlockId`s here, set them on the `PartialBlock.id` field BlockNote
    // honours (verified: `@blocknote/core/src/api/nodeConversions/
    // blockToNode.ts` uses the provided id when present, only calling
    // its own `UniqueID.options.generateID()` when `id === undefined`),
    // and thread the same list into the `doc.create` audit effect via
    // the output's `seed_blocks` field. Invariant 3a (audit replay
    // reconstructs final state) becomes true for the initial block
    // layout: a replay reducer seeing `{ kind: "doc.create",
    // seed_blocks: [...] }` can call `seedBlocks(ydoc, seed_blocks)`
    // and land on the same Y.XmlFragment the original write produced.
    // A later `doc.rename` / `doc.update` that references these IDs has
    // a stable audit-recorded target, not a BlockNote-internal id the
    // trail never saw.
    await ctx.db
      .insertInto("docs")
      .values({
        id: doc_id,
        workspace_id,
        collection_id,
        title,
        slug,
        order_key,
        visibility,
        visibility_version: 0,
        created_by,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .execute();

    const seed_blocks: SeedBlock[] = [
      { id: generateBlockId(), type: "heading", props: { level: 1 }, content: title },
      { id: generateBlockId(), type: "paragraph", content: "" },
    ];
    const seed = seed_blocks.map((b) => ({
      id: b.id,
      type: b.type,
      props: b.props,
      content: b.content,
    })) as unknown as LoosePartialBlock[];
    await ctx.transact(doc_id, (editor) => {
      seedBlocks(editor as Y.Doc, seed);
    });
    // The `DocUpdatesWriter` auto-bootstraps `doc_counters(doc_id,
    // next_seq=1)` inside the write-path tx on the first write (closes
    // F104 P2 / Codex P3.6c adversarial P3): no dispatcher-side priming
    // step needed, no handler-surface exposure of the system-only
    // `doc_counters` table (F98), and the bootstrap is tx-local so a
    // rolled-back `doc.create` leaves no orphan counter.

    return {
      doc_id,
      workspace_id,
      collection_id,
      title,
      slug,
      order_key,
      visibility,
      seed_blocks,
    };
  },
};
