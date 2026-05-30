/// <reference lib="dom" />

/**
 * `doc.update` — canonical batched block-mutation capability
 * (architecture.md §6.5 + §16.3, ADR 0018, ADR 0022, F12 + F33).
 *
 * **Why a batched op-list** (F12). Earlier drafts had separate
 * `block.insert` / `block.update` / `block.remove` capabilities. F12
 * collapses them: one rate-limit bucket (can't evade a 600/min
 * `doc.write` budget by splitting to N single-op calls), one audit
 * model (`doc.update_batch` captures the full op list), one mental
 * model for agents. Every block mutation a surface wants to express
 * lowers to one `doc.update` call with N ops.
 *
 * **Slice-1 scope** (2026-04-21). Three of the five ops in the
 * `doc.update_batch` audit-effect shape land today:
 *
 *   - `insert` — append or splice a new block. Uses BlockNote's
 *     `editor.insertBlocks(blocks, reference, placement)`. Caller
 *     supplies `after_block_id`; `null` means "insert at top"
 *     (placement `before` against block 0).
 *   - `update` — replace a block's content / type / props in place.
 *     Uses `editor.updateBlock(block, patch)`. Supports the optional
 *     `expect_prior_content_hash` precondition (ADR 0022 §57). Empty
 *     patch `{}` is rejected at the input schema — see the refinement
 *     on `UpdatePatchInput` below for why.
 *   - `remove` — delete a block. Uses `editor.removeBlocks`. Also
 *     supports `expect_prior_content_hash`. Audit effect captures the
 *     **preimage** so a reducer can reconstruct deletion-undo.
 *
 * **Deferred for follow-on slices.**
 *
 *   - `move` — blocks keep their `id` across reorder (F33 invariant:
 *     native moves emit `move` ops, not `remove+insert`). BlockNote's
 *     id-preserving reorder path needs its own integration smoke;
 *     deferring keeps this slice tight and does not preclude the op
 *     shape from landing later (the audit-effect union already has
 *     the `move` variant).
 *   - `set_visibility` — block-level visibility isn't a projected
 *     feature yet. Adding the op without the surrounding read path
 *     would print a label downstream readers don't honour.
 *
 * Both deferrals are discriminated-union members the handler rejects
 * at the input schema (the `op` literal union below) rather than at
 * the runtime — a caller passing `{ op: "move", ... }` gets a zod
 * `invalid_union_discriminator` 400 with the two remaining cases
 * named. When the follow-on slices land, adding the literal to the
 * union and the op branch to the handler is a mechanical extension.
 *
 * **Optimistic concurrency — `expect_prior_content_hash`** (ADR 0022).
 * The `update` and `remove` ops accept an optional
 * `expect_prior_content_hash: string` field. When present, the handler
 * reads the current block from `editor.document` inside the `withLiveEditor`
 * closure, computes `stableHash({ type, props, content })` over the
 * canonical JSON of the block's editable state, and compares. Mismatch
 * throws `StalePreconditionError` (409 / `code: "stale_precondition"`) —
 * the transact closure has not committed; no partial write lands (the
 * dispatcher rolls back the full tx + `BoundSyncService.rollback` evicts
 * the resident Y.Doc).
 *
 * Hash shape: canonical JSON of `{ type, props, content }` — the three
 * fields that identify the block's editable state. `id`, structural
 * metadata (parent_block_id, order_key), and visibility are intentionally
 * excluded — they represent location, not content, and including them
 * would couple "same content" to "same position" (a move op would
 * spuriously invalidate an update's precondition). Matches ADR 0022's
 * "canonical JSON of block content" reading. The canonicalize + sha256
 * pair is inlined here (duplicate of the dispatcher's private `stableHash`)
 * because ADR 0022 explicitly calls out the same canonicalisation the
 * dispatcher uses; extracting to a shared helper is a future refactor
 * when a third consumer emerges.
 *
 * **Single-tx atomicity**. All ops apply inside one `editor.transact` →
 * one Yjs update blob → one `doc_updates` row. The handler calls
 * `ctx.transact` exactly once (enforced by `TransactCalledTwiceError`).
 * `editor.transact` is a BlockNote-internal batching primitive that
 * wraps the ops in a single y-prosemirror step. This matches §6.5's
 * "one editor.transact = one doc_updates" contract.
 *
 * **`updated_at` bridge**. The handler UPDATE-first-reads `docs` with
 * `.set({ updated_at: now })` + `.returning("id", "updated_at")` so:
 *   - Missing / soft-deleted doc → 404 short-circuit (same pattern as
 *     `doc.rename`; running `ctx.transact` against a missing doc would
 *     auto-bootstrap `doc_counters` then fail on the FK at commit).
 *   - `doc.list` / `doc.get` see the update timestamp bump in the same
 *     tx as the CRDT mutation (row-side freshness parity with the
 *     row-metadata bridge `doc.rename` also maintains, §6.5 caveat).
 *
 * **Scopes**. `doc:write` + `block:write`. Both held by member / admin /
 * owner roles; guest holds neither (guests can read but not author).
 *
 * **`setDocTitle` / `doc.rename` coexistence**. `doc.rename` owns the
 * title-slot rule (block 0 heading-1 in place or insert). `doc.update`
 * does not special-case block 0 — a caller using `doc.update` to edit
 * the title will mutate block 0 generically. Future clients that want
 * "rename semantics" (strict index-0, row-side title+slug bridge) use
 * `doc.rename`; `doc.update` stays format-agnostic.
 */

import { createHash } from "node:crypto";
import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  BlockPostState,
  BlockVisibility,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { NotFoundError, StalePreconditionError } from "@editorzero/errors";
import { BlockId, CapabilityId, type DocId, generateBlockId } from "@editorzero/ids";
import {
  type DocUpdateInput,
  DocUpdateInputSchema,
  type DocUpdateOutput,
  DocUpdateOutputSchema,
  type InsertOpInputSchema,
  type RemoveOpInputSchema,
  type UpdateOpInputSchema,
} from "@editorzero/schemas/doc/update";
import { type LoosePartialBlock, withLiveEditor } from "@editorzero/sync";
import type * as Y from "yjs";
import type { z } from "zod";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_UPDATE_ID = CapabilityId("doc.update");
const DEFAULT_BLOCK_VISIBILITY: BlockVisibility = "default";

// ── Wire + internal contract ───────────────────────────────────────────────
//
// The input / output schemas (and the per-op schemas the appliers re-derive
// their types from) are the single source (ADR 0034), reused verbatim by the
// API route's `validator` / `resolver` so the wire contract has exactly one
// definition. They live in `@editorzero/schemas/doc/update`; the capability
// semantics that shape them (the discriminated `op` union with the deferred
// `move` / `set_visibility` cases rejected at the schema, `.strict()` at every
// level, the non-empty-patch refinement, the `expect_prior_content_hash`
// precondition format, the block-visibility enum distinct from doc-visibility)
// are documented in the file header above and at the schema definitions.

// `Input` / `Output` keep their short local names so the handler + applier
// bodies read unchanged; both alias the branded `z.output` projections.
type Input = DocUpdateInput;
type Output = DocUpdateOutput;

// ── Hash helpers (ADR 0022) ──────────────────────────────────────────────

/** Recursively key-sort; produces canonical JSON under `JSON.stringify`. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const plain = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(plain).sort()) sorted[key] = canonicalize(plain[key]);
  return sorted;
}

function stableHash(input: unknown): string {
  const json = JSON.stringify(canonicalize(input)) ?? "";
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Hash over the block's *editable* state — type + props + content. `id`,
 * structural metadata (parent / order_key), and visibility are excluded
 * so a `move` or `set_visibility` op never invalidates an in-flight
 * update's precondition. Matches ADR 0022 §57's framing: preconditions
 * are about content, not location.
 */
function hashBlockContent(block: {
  readonly type: string;
  readonly props?: unknown;
  readonly content?: unknown;
}): string {
  return stableHash({ type: block.type, props: block.props, content: block.content });
}

// ── Block projection ─────────────────────────────────────────────────────
//
// Projects a live BlockNote block into the audit-effect `BlockPostState`
// shape. `order_key` is synthesised from the block's document index —
// the real fractional-index projection is the projection-blocks job's
// concern (architecture.md §16.11), not yet landed. Until that slice,
// a stable index-based key at the audit boundary keeps the effect
// structurally valid without promising ordering guarantees the
// projection layer will ultimately own.
// `parent_block_id` is `null` for slice 1 — nested blocks are not yet
// a projected feature (ADR 0013 lossless-tier blocks that nest render
// flat in the current projection stub).

interface LiveBlockLike {
  readonly id: string;
  readonly type: string;
  readonly props?: unknown;
  readonly content?: unknown;
}

function projectToPostState(block: LiveBlockLike, doc_id: DocId, index: number): BlockPostState {
  return {
    id: BlockId(block.id),
    doc_id,
    type: block.type,
    parent_block_id: null,
    // Fixed-width index → lexicographically sortable; replaced by the
    // fractional-index projection job when it lands.
    order_key: String(index).padStart(6, "0"),
    content_json: canonicalize({
      ...(block.props !== undefined ? { props: block.props } : {}),
      ...(block.content !== undefined ? { content: block.content } : {}),
    }),
    visibility: DEFAULT_BLOCK_VISIBILITY,
  };
}

// ── Capability ───────────────────────────────────────────────────────────

export const docUpdate: Capability<Input, Output> = {
  id: DOC_UPDATE_ID,
  category: "mutation",
  summary: "Apply a batch of block mutations (insert / update / remove) to a doc's CRDT content.",
  input: DocUpdateInputSchema,
  output: DocUpdateOutputSchema,
  requires: ["doc:write", "block:write"],
  agentAllowed: {},
  surfaces: ["api", "cli", "mcp", "ui"],
  audit: {
    subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
    effectOnAllow: (_input, output): AuditEffect => ({
      kind: "doc.update_batch",
      doc_id: output.doc_id,
      ops: output.applied_ops.map((op) => {
        if (op.op === "insert") {
          return {
            op: "insert" as const,
            block: op.block,
            after_block_id: op.after_block_id,
            parent_block_id: op.parent_block_id,
          };
        }
        if (op.op === "update") {
          return { op: "update" as const, block_id: op.block_id, post: op.post };
        }
        return { op: "remove" as const, block_id: op.block_id, preimage: op.preimage };
      }),
    }),
    effectOnDeny: (_input, reason: DenyReason): AuditDeny => ({
      kind: "deny",
      capability: DOC_UPDATE_ID,
      required_scopes: ["doc:write", "block:write"],
      reason_code: reason.kind,
    }),
    effectOnError: (_input, error: HandlerError): AuditError =>
      projectErrorAudit(DOC_UPDATE_ID, error),
    collapsePolicy: { collapsible: false },
  },
  handler: async (ctx, input) => {
    const now = ctx.now();

    // Step 1 — UPDATE-first for 404 short-circuit + updated_at bump.
    // Same pattern as `doc.rename`: a SELECT would avoid the row-side
    // write but then `doc.list` / `doc.get` wouldn't reflect the batch
    // until a projection job catches up. Keeping the bridge write
    // keeps row-side freshness coherent with the CRDT mutation.
    const row = await ctx.db
      .updateTable("docs")
      .set({ updated_at: now })
      .where("id", "=", input.doc_id)
      .where("deleted_at", "is", null)
      .returning(["id", "updated_at"])
      .executeTakeFirst();

    if (row === undefined) {
      throw new NotFoundError({ subject_kind: "doc", subject_id: input.doc_id });
    }

    // Step 2 — apply all ops inside ONE `editor.transact`. Kernel
    // `TEditor` is still `unknown` (kernel.ts header); the single
    // documented cast narrows to Y.Doc here, same dance `doc.create`
    // and `doc.rename` use.
    const appliedOps: Output["applied_ops"] = [];
    await ctx.transact(input.doc_id, async (editor) => {
      await withLiveEditor(editor as Y.Doc, (liveEd) => {
        liveEd.transact(() => {
          for (const op of input.ops) {
            if (op.op === "insert") {
              applyInsert(liveEd, op, input.doc_id, appliedOps);
            } else if (op.op === "update") {
              applyUpdate(liveEd, op, input.doc_id, appliedOps);
            } else {
              applyRemove(liveEd, op, input.doc_id, appliedOps);
            }
          }
        });
      });
    });

    return {
      doc_id: row.id,
      applied_ops: appliedOps,
      updated_at: row.updated_at,
    };
  },
};

// ── Per-op appliers ──────────────────────────────────────────────────────
//
// Split out so the handler reads linearly and each op's branch has a
// single responsibility. All three mutate `appliedOps` as a side effect —
// the output array is the handler's accumulator, and each applier pushes
// exactly one entry matching the op it applied. The `liveEd` parameter
// is the live BlockNoteEditor inside the `editor.transact` closure.

type LiveEditorLike = {
  readonly document: ReadonlyArray<LiveBlockLike>;
  readonly insertBlocks: (
    blocks: LoosePartialBlock[],
    ref: LiveBlockLike,
    placement: "before" | "after",
  ) => void;
  readonly updateBlock: (block: LiveBlockLike, patch: LoosePartialBlock) => void;
  readonly removeBlocks: (blocks: LiveBlockLike[]) => void;
};

type InsertOp = z.output<typeof InsertOpInputSchema>;
type UpdateOp = z.output<typeof UpdateOpInputSchema>;
type RemoveOp = z.output<typeof RemoveOpInputSchema>;

function applyInsert(
  liveEd: LiveEditorLike,
  op: InsertOp,
  doc_id: DocId,
  appliedOps: Output["applied_ops"],
): void {
  const insertId = generateBlockId();
  // BlockNote honours `PartialBlock.id` — `@blocknote/core/src/api/
  // nodeConversions/blockToNode.ts` only mints its own id when the
  // caller's is `undefined`. Minting here threads the `BlockId` into
  // both the CRDT and the audit effect in one step.
  const partial: LoosePartialBlock = {
    id: insertId,
    type: op.block.type,
    ...(op.block.props !== undefined ? { props: op.block.props as Record<string, unknown> } : {}),
    ...(op.block.content !== undefined ? { content: op.block.content } : {}),
  } as unknown as LoosePartialBlock;

  if (op.after_block_id === null) {
    // Insert at the top — use block 0 as reference with `before`.
    // `withLiveEditor`'s mount normalisation keeps at least one block,
    // so `document[0]` is never undefined at this point; the defensive
    // throw catches regressions in BlockNote's mount semantics without
    // surfacing to users (it'd be a 500 trace in practice).
    const first = liveEd.document[0];
    if (first === undefined) {
      throw new Error(
        "doc.update insert: live editor's document is empty — withLiveEditor mount invariant broken.",
      );
    }
    liveEd.insertBlocks([partial], first, "before");
  } else {
    const ref = liveEd.document.find((b) => b.id === op.after_block_id);
    if (ref === undefined) {
      throw new NotFoundError({ subject_kind: "block", subject_id: op.after_block_id });
    }
    liveEd.insertBlocks([partial], ref, "after");
  }

  const idx = liveEd.document.findIndex((b) => b.id === insertId);
  const inserted = liveEd.document[idx];
  if (inserted === undefined) {
    throw new Error(
      "doc.update insert: insertBlocks did not surface the minted block; " +
        "BlockNote ID-preservation contract violated.",
    );
  }

  appliedOps.push({
    op: "insert",
    block: projectToPostState(inserted, doc_id, idx),
    after_block_id: op.after_block_id,
    parent_block_id: null,
  });
}

function applyUpdate(
  liveEd: LiveEditorLike,
  op: UpdateOp,
  doc_id: DocId,
  appliedOps: Output["applied_ops"],
): void {
  const current = liveEd.document.find((b) => b.id === op.block_id);
  if (current === undefined) {
    throw new NotFoundError({ subject_kind: "block", subject_id: op.block_id });
  }

  if (op.expect_prior_content_hash !== undefined) {
    const actual = hashBlockContent(current);
    if (actual !== op.expect_prior_content_hash) {
      throw new StalePreconditionError({
        block_id: BlockId(current.id),
        expected_hash: op.expect_prior_content_hash,
        actual_hash: actual,
      });
    }
  }

  const patch: LoosePartialBlock = {
    ...(op.patch.type !== undefined ? { type: op.patch.type } : {}),
    ...(op.patch.props !== undefined ? { props: op.patch.props as Record<string, unknown> } : {}),
    ...(op.patch.content !== undefined ? { content: op.patch.content } : {}),
  } as unknown as LoosePartialBlock;
  liveEd.updateBlock(current, patch);

  const idx = liveEd.document.findIndex((b) => b.id === op.block_id);
  const after = liveEd.document[idx];
  if (after === undefined) {
    throw new Error(
      "doc.update update: updateBlock dropped the target block — BlockNote contract violated.",
    );
  }

  appliedOps.push({
    op: "update",
    block_id: op.block_id,
    post: projectToPostState(after, doc_id, idx),
  });
}

function applyRemove(
  liveEd: LiveEditorLike,
  op: RemoveOp,
  doc_id: DocId,
  appliedOps: Output["applied_ops"],
): void {
  const current = liveEd.document.find((b) => b.id === op.block_id);
  if (current === undefined) {
    throw new NotFoundError({ subject_kind: "block", subject_id: op.block_id });
  }

  if (op.expect_prior_content_hash !== undefined) {
    const actual = hashBlockContent(current);
    if (actual !== op.expect_prior_content_hash) {
      throw new StalePreconditionError({
        block_id: BlockId(current.id),
        expected_hash: op.expect_prior_content_hash,
        actual_hash: actual,
      });
    }
  }

  const idx = liveEd.document.findIndex((b) => b.id === op.block_id);
  const preimage = projectToPostState(current, doc_id, idx);
  liveEd.removeBlocks([current]);

  appliedOps.push({
    op: "remove",
    block_id: op.block_id,
    preimage,
  });
}

/**
 * Exposed for tests that want to assert hash values on synthesised
 * blocks without reaching inside the handler. Not part of the runtime
 * public API — downstream consumers should not depend on this.
 *
 * @internal
 */
export const __internal = { hashBlockContent, stableHash, canonicalize };
