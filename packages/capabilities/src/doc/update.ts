/**
 * `doc.update` — canonical batched block-mutation capability
 * (architecture.md §6.5 + §16.3, ADR 0018, ADR 0022, ADR 0038, F12 + F33).
 *
 * **Why a batched op-list** (F12). Earlier drafts had separate
 * `block.insert` / `block.update` / `block.remove` capabilities. F12
 * collapses them: one rate-limit bucket (can't evade a 600/min
 * `doc.write` budget by splitting to N single-op calls), one audit
 * model (`doc.update_batch` captures the full op list), one mental
 * model for agents. Every block mutation a surface wants to express
 * lowers to one `doc.update` call with N ops.
 *
 * **The op semantics live in `@editorzero/blocks`** (`applyOpsToBlocks`
 * — pure, ADR 0038), shared with the Web UI editor's diff
 * (`diffBlocksToOps`) so the client that *generates* ops and the
 * server that *applies* them cannot drift. This handler owns the
 * SQL-side bridge + the CRDT write: read the current block list from
 * the Y.Doc, run the pure applier (which mints `BlockId`s for inserts,
 * enforces `expect_prior_content_hash` — ADR 0022 §57 — and projects
 * the audit post-states), then `writeBlocks` the post-state in ONE
 * Yjs transaction → one `doc_updates` row (§6.5's contract). The
 * pre-0038 BlockNote path (happy-dom + mounted live editor +
 * `editor.transact`) is gone.
 *
 * **Slice scope.** Three of the five ops in the `doc.update_batch`
 * audit-effect shape: `insert` / `update` / `remove`. Deferred:
 *
 *   - `move` — blocks keep their `id` across reorder (F33 invariant:
 *     native moves emit `move` ops, not `remove+insert`). The audit
 *     effect union already carries the variant; the op lands with the
 *     editor's block-drag UI.
 *   - `set_visibility` — block-level visibility isn't a projected
 *     feature yet. Adding the op without the surrounding read path
 *     would print a label downstream readers don't honour.
 *
 * Both deferrals are rejected at the input schema (the `op` literal
 * union) — a caller passing `{ op: "move", ... }` gets a zod
 * `invalid_union_discriminator` 400 with the two remaining cases
 * named.
 *
 * **Optimistic concurrency — `expect_prior_content_hash`** (ADR 0022).
 * `update` / `remove` ops accept an optional sha-256 over the
 * canonical JSON of the block's editable state `{ type, props,
 * content }` (`@editorzero/blocks` `hashBlockContent` — isomorphic, so
 * the Web UI stamps the same hash it verifies). Mismatch throws
 * `StalePreconditionError` (409) from inside the applier — the
 * transact closure has not committed; the dispatcher rolls back the
 * full tx and `BoundSyncService.rollback` evicts the resident Y.Doc.
 *
 * **`updated_at` bridge**. The handler UPDATE-first-reads `docs` with
 * `.set({ updated_at: now })` + `.returning(...)` so:
 *   - Missing / soft-deleted doc → 404 short-circuit (same pattern as
 *     `doc.rename`; running `ctx.transact` against a missing doc would
 *     auto-bootstrap `doc_counters` then fail on the FK at commit).
 *   - `doc.list` / `doc.get` see the update timestamp bump in the same
 *     tx as the CRDT mutation (§6.5 row-side freshness parity).
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

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import { applyOpsToBlocks, canonicalize, hashBlockContent, stableHash } from "@editorzero/blocks";
import { NotFoundError } from "@editorzero/errors";
import { CapabilityId, generateBlockId } from "@editorzero/ids";
import {
  type DocUpdateInput,
  DocUpdateInputSchema,
  type DocUpdateOutput,
  DocUpdateOutputSchema,
} from "@editorzero/schemas/doc/update";
import { readBlocks, writeBlocks } from "@editorzero/sync";
import type * as Y from "yjs";

import { projectErrorAudit } from "../audit-helpers";
import type { Capability } from "../kernel";

const DOC_UPDATE_ID = CapabilityId("doc.update");

// ── Wire + internal contract ───────────────────────────────────────────────
//
// The input / output schemas are the single source (ADR 0034), reused
// verbatim by the API route's `validator` / `resolver` so the wire
// contract has exactly one definition. They live in
// `@editorzero/schemas/doc/update`; the capability semantics that shape
// them (the discriminated `op` union with the deferred `move` /
// `set_visibility` cases rejected at the schema, `.strict()` at every
// level, the non-empty-patch refinement, the `expect_prior_content_hash`
// precondition format, the block-visibility enum distinct from
// doc-visibility) are documented in the file header above and at the
// schema definitions.

type Input = DocUpdateInput;
type Output = DocUpdateOutput;

// ── Capability ───────────────────────────────────────────────────────────

export const docUpdate: Capability<Input, Output> = {
  id: DOC_UPDATE_ID,
  category: "mutation",
  summary: "Apply a batch of block mutations (insert / update / remove) to a doc's CRDT content.",
  input: DocUpdateInputSchema,
  output: DocUpdateOutputSchema,
  requires: ["doc:write", "block:write"],
  agentAllowed: {},
  // "ui" bound by the `/doc/$docId` editor's explicit Save (diff → ops
  // batch); proven by the marked Playwright spec in packages/e2e (H11).
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

    // Step 2 — read → pure applier → ONE writeBlocks (one Yjs update
    // blob, one `doc_updates` row). Kernel `TEditor` is still
    // `unknown` (kernel.ts header); the single documented cast narrows
    // to Y.Doc here, same dance `doc.create` and `doc.rename` use.
    let appliedOps: Output["applied_ops"] = [];
    await ctx.transact(input.doc_id, async (editor) => {
      const ydoc = editor as Y.Doc;
      const result = await applyOpsToBlocks(readBlocks(ydoc), input.ops, {
        doc_id: input.doc_id,
        mintId: generateBlockId,
      });
      writeBlocks(ydoc, result.post);
      appliedOps = result.applied;
    });

    return {
      doc_id: row.id,
      applied_ops: appliedOps,
      updated_at: row.updated_at,
    };
  },
};

/**
 * Exposed for tests that want to assert hash values on synthesised
 * blocks without reaching inside the applier. Re-exports of the
 * `@editorzero/blocks` isomorphic helpers (async since ADR 0038 —
 * WebCrypto). Not part of the runtime public API.
 *
 * @internal
 */
export const __internal = { hashBlockContent, stableHash, canonicalize };
