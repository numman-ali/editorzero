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
 * Slug derivation is naive in v1 (kebab-case of title; empty →
 * "untitled"). The handler runs a sibling-slug pre-check SELECT
 * (NULL-aware `collection_id` scope, matching the `docs_root_slug_unique`
 * / `docs_nested_slug_unique` partial indexes the collections slice
 * added) and throws `SlugCollisionError` (409, `code: "slug_collision"`)
 * on hit — a typed 409 on the common path rather than a raw DB UNIQUE
 * violation the dispatcher would project to `internal` (500). The
 * partial unique indexes remain the last-line guard for the race window
 * (pre-check → INSERT with a concurrent sibling); that rare edge still
 * audits as `internal`, but common cases get a typed response. Mirrors
 * `collection.create`'s slug-collision shaping so the two create paths
 * stay symmetric.
 *
 * **Optional `collection_id`.** Callers may specify a collection
 * to place the new doc in; when absent (or explicit `null`) the
 * doc lands at workspace root. The collection must exist in the
 * caller's workspace and be live (not soft-deleted) — the handler
 * SELECTs it through `ctx.db` and returns 404 otherwise. Scoping
 * is enforced by the tenant plugin's WHERE injection; an attacker
 * who invents a `CollectionId` that exists in another workspace
 * gets 404, same as a freshly-minted id that exists nowhere. The
 * doc's workspace/collection coupling is structurally guarded by
 * `docs.collection_id`'s handler-enforced referential integrity
 * (schema.ts header: no FK in DDL so tests can stand DOCS_DDL up
 * in isolation; the SELECT+reject pattern substitutes).
 *
 * **Placement ceiling (ADR 0040 Step 6; Codex review HIGH 1).** A
 * live target collection must also be REACHABLE: creating a doc is
 * a placement-changing write, and `created_by` makes the caller a
 * permanent implicit owner of the new doc — so an outsider who can
 * plant a doc inside a closed/private Space's collection would
 * punch a permanent hole through that Space's ceiling. After the
 * existence check the handler loads the ceiling resolver and
 * `assertCanPlaceIn(collection_id)`: legacy placements (unspaced
 * collection) always pass, anomalies always fail, live-space
 * placements require baseline reach (membership / space grant /
 * open-space user baseline). Denies throw `acl_deny` scoped to the
 * collection — a 403 with a deny audit row, AFTER the 404 check so
 * unreachable-vs-nonexistent stays distinguishable only for rows
 * that actually exist in the caller's workspace (same 403-reveal
 * posture as `doc.get`). Root creates (`collection_id null`) skip
 * the resolver load entirely — zero overhead on the common path.
 *
 * **`access_mode` is not caller-settable (ADR 0040 Step 5).**
 * `doc.list`/`doc.get` still return every non-deleted doc in the
 * workspace — the ceiling resolver (Step 6) is what makes
 * `access_mode` mean something on reads. Accepting `"private"` at
 * create would print a label the read path doesn't honour yet
 * (false privacy), so every new doc lands as `"space"` and the
 * mode switch arrives with the Step-8 ACL capability family. A doc
 * is never born published either — publish is `doc.publish`'s job
 * (scope `doc:publish`, which members holding only `doc:write`
 * don't get). `InputSchema.strict()` makes a caller-supplied
 * `access_mode` a zod `unrecognized_keys` issue — a 400 with a
 * clear path reference, not a silent drop.
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
import { NotFoundError, SlugCollisionError, ValidationError } from "@editorzero/errors";
import {
  CapabilityId,
  type CollectionId,
  type DocId,
  generateBlockId,
  generateDocId,
} from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import {
  type DocCreateInput,
  DocCreateInputSchema,
  type DocCreateOutput,
  DocCreateOutputSchema,
} from "@editorzero/schemas/doc/create";
import { seedBlocks } from "@editorzero/sync";
import type * as Y from "yjs";

import { loadDocReadResolver } from "../acl/ceiling";
import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_CREATE_ID = CapabilityId("doc.create");
const DEFAULT_ACCESS_MODE = "space" as const;

// ── Wire + internal contract ───────────────────────────────────────────────
//
// `docCreateInputSchema` / `docCreateOutputSchema` are the single source
// (ADR 0034), reused verbatim by the API route's `validator` / `resolver`
// so the wire contract has exactly one definition. `InferInput` is the
// wire shape (plain strings); each field's `.transform()` narrows to the
// branded internal shape — `DocCreateInput` / `DocCreateOutput`. The
// capability semantics that shape these (access_mode not caller-settable,
// `.strict()` rejecting unknown keys, the trim-then-`min(1)` title rule,
// `seed_blocks` carried on the output so `effectOnAllow` can project it
// without ctx access) are documented in the file header above and at the
// schema definition in `@editorzero/schemas/doc/create`.

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

export const docCreate: Capability<DocCreateInput, DocCreateOutput> = {
  id: DOC_CREATE_ID,
  category: "mutation",
  summary: "Create a new document in the caller's workspace; seeds the Y.Doc with a title block.",
  input: DocCreateInputSchema,
  output: DocCreateOutputSchema,
  requires: ["doc:write"],
  agentAllowed: {},
  // "ui" is declared because the Web UI actually binds this capability
  // (the docs panel's "+ New doc" form; proven by the marked Playwright
  // spec in packages/e2e). Declared surfaces = bound surfaces (ADR 0040
  // H11) — packages/contract-tests fails the build if "ui" appears here
  // without a proving spec, or vice versa.
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
      created_by: output.created_by,
      access_mode: output.access_mode,
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
    const collection_id: CollectionId | null = input.collection_id ?? null;
    // Collection existence check when supplied. The tenant plugin
    // auto-applies `workspace_id`, so a caller who invents a
    // `CollectionId` that exists in another workspace gets 404 — the
    // same surface as a freshly-minted id that exists nowhere. No
    // information leak. Soft-deleted collections are treated as
    // not-found (same rule as `doc.get`): the `deleted_at IS NULL`
    // predicate filters them; if the caller holds `collection:
    // restore` they use that explicit path, not this implicit one.
    if (collection_id !== null) {
      const row = await ctx.db
        .selectFrom("collections")
        .select(["id"])
        .where("id", "=", collection_id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (row === undefined) {
        throw new NotFoundError({ subject_kind: "collection", subject_id: collection_id });
      }
      // Placement ceiling (file header §Placement ceiling): the caller
      // must REACH the target placement, not merely know its id. Runs
      // before any write — on deny, no docs row and no Y.Doc seed
      // exist. Root creates never get here (no resolver load).
      const acl = await loadDocReadResolver(ctx.db, ctx.principal);
      acl.assertCanPlaceIn(collection_id);
    }
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
    const access_mode = DEFAULT_ACCESS_MODE;
    const now = ctx.now();
    const created_by = resolveCreatedBy(ctx.principal);

    // Sibling-slug pre-check. Typed 409 on the common path rather than
    // letting the partial unique index (`docs_root_slug_unique` /
    // `docs_nested_slug_unique`) bubble as a raw UNIQUE violation — which
    // the dispatcher projects to `internal` (500). NULL-aware
    // `collection_id` scope matches the two indexes the DDL defines (one
    // for workspace-root docs, one for collection-nested). The tenant
    // plugin auto-applies `workspace_id`, so the SELECT predicate mirrors
    // each index's partial predicate exactly. The race window (this
    // SELECT → the INSERT below) stays guarded by the indexes as the
    // last-line enforcement; an interleaved concurrent sibling still
    // re-raises as a UNIQUE violation / `internal` audit. Mirrors
    // `collection.create`'s slug-collision shaping.
    let slugClash: { id: DocId } | undefined;
    if (collection_id === null) {
      slugClash = await ctx.db
        .selectFrom("docs")
        .select(["id"])
        .where("collection_id", "is", null)
        .where("slug", "=", slug)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
    } else {
      slugClash = await ctx.db
        .selectFrom("docs")
        .select(["id"])
        .where("collection_id", "=", collection_id)
        .where("slug", "=", slug)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
    }
    if (slugClash !== undefined) {
      throw new SlugCollisionError({
        slug,
        parent_kind: collection_id === null ? "workspace" : "collection",
        parent_id: collection_id,
      });
    }

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
    // **Pre-minted block IDs (closes Codex F104 P1 / gap (b)).** We mint
    // `BlockId`s here, pass them straight through `seedBlocks` (the
    // owned write path persists the caller's id verbatim — ADR 0038's
    // `SeedBlock` makes the id mandatory), and thread the same list
    // into the `doc.create` audit effect via the output's
    // `seed_blocks` field. Invariant 3a (audit replay reconstructs
    // final state) holds for the initial block layout: a replay
    // reducer seeing `{ kind: "doc.create", seed_blocks: [...] }` can
    // call `seedBlocks(ydoc, seed_blocks)` and land on the same
    // Y.XmlFragment the original write produced. A later `doc.rename`
    // / `doc.update` that references these IDs has a stable
    // audit-recorded target.
    await ctx.db
      .insertInto("docs")
      .values({
        id: doc_id,
        workspace_id,
        collection_id,
        title,
        slug,
        order_key,
        access_mode,
        published_slug: null,
        published_at: null,
        render_version: 0,
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
    await ctx.transact(doc_id, (editor) => {
      seedBlocks(editor as Y.Doc, seed_blocks);
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
      created_by,
      access_mode,
      published_slug: null,
      published_at: null,
      seed_blocks,
    };
  },
};
