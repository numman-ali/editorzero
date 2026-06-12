/**
 * `doc.update` op semantics — pure (ADR 0038).
 *
 * Two halves of one contract, kept in one file so they cannot drift:
 *
 *   - `applyOpsToBlocks` — the SERVER half. Applies a validated op
 *     list to a block list, minting ids for inserts, enforcing
 *     `expect_prior_content_hash` preconditions (ADR 0022), and
 *     projecting the audit `BlockPostState` per op. The `doc.update`
 *     capability runs this inside `ctx.transact` and hands the post
 *     list to `@editorzero/sync.writeBlocks`. Before ADR 0038 these
 *     semantics lived as BlockNote `insertBlocks`/`updateBlock`/
 *     `removeBlocks` calls against a happy-dom-mounted live editor;
 *     they are now plain list operations.
 *
 *   - `diffBlocksToOps` — the CLIENT half (the HTTP-first Web UI
 *     editor). Diffs the loaded block list against the edited one and
 *     emits the wire op list that `applyOpsToBlocks` will replay to
 *     the same end state. The round-trip law — apply(before,
 *     diff(before, after)) ≡ after, modulo server-minted insert ids —
 *     is pinned by a property test.
 *
 * Semantics worth naming:
 *
 *   - **Insert ids are server-minted** (invariant 3a): the wire insert
 *     op carries no id; `applyOpsToBlocks` mints via the injected
 *     `mintId`. The diff therefore strips ids from anything it has to
 *     re-insert.
 *   - **Props patches shallow-merge** (`{...current, ...patch}`), then
 *     the *target type's* attribute schema re-parses the merged bag —
 *     unknown keys are stripped, defaults applied (a paragraph →
 *     heading retype gains `level: 1`). Content-only patches leave
 *     props untouched.
 *   - **Reorders lower to remove + insert** for now: the `move` op is
 *     deferred at the input schema (F33 keeps the audit-effect union
 *     member reserved), and the v1 editor has no block-drag UI. A
 *     moved block loses its id; the LCS keeps that set minimal.
 *   - **Insert anchoring is LCS-stable**: every insert anchors to the
 *     nearest *surviving* preceding block, and inserts are emitted in
 *     reverse document order so consecutive new blocks stack correctly
 *     after a shared anchor (`after_block_id` can only name a block
 *     that exists server-side when the op applies).
 */

import { NotFoundError, StalePreconditionError } from "@editorzero/errors";
import { BlockId, type DocId } from "@editorzero/ids";
import type {
  DocUpdateOutput,
  DocUpdateWireInput,
  InsertOpInputSchema,
  RemoveOpInputSchema,
  UpdateOpInputSchema,
} from "@editorzero/schemas/doc/update";
import type { z } from "zod";

import { headingAttributes } from "./core/heading";
import { paragraphAttributes } from "./core/paragraph";
import { canonicalize, hashBlockContent } from "./hash";
import { type Block, materializeBlock, normalizeContent } from "./model";

type InsertOp = z.output<typeof InsertOpInputSchema>;
type UpdateOp = z.output<typeof UpdateOpInputSchema>;
type RemoveOp = z.output<typeof RemoveOpInputSchema>;
type Op = InsertOp | UpdateOp | RemoveOp;

type AppliedOps = DocUpdateOutput["applied_ops"];
type BlockPostState = Extract<AppliedOps[number], { op: "insert" }>["block"];

type WireOps = DocUpdateWireInput["ops"];

/**
 * Per-type attribute schemas — the same zod instances the Markdown
 * specs declare (SSOT). The applier parses merged props through the
 * target type's schema; the PM mapping's prop-key allowlist stays in
 * lockstep via the schema round-trip tests. Structural `parse` shape
 * rather than `ZodType<...>` because zod's generic is invariant in its
 * output — a `z.object({})` would not unify with the record-typed
 * heading schema under one `ZodType` annotation.
 */
type AttributeParser = { readonly parse: (value: unknown) => Record<string, unknown> };

const ATTRIBUTE_SCHEMAS: Readonly<Record<string, AttributeParser>> = {
  paragraph: paragraphAttributes,
  heading: headingAttributes,
};

function parseProps(
  type: string,
  merged: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const schema = ATTRIBUTE_SCHEMAS[type];
  if (schema === undefined) {
    throw new Error(`applyOpsToBlocks: unsupported block type "${type}"`);
  }
  return schema.parse(merged);
}

function projectPostState(block: Block, doc_id: DocId, index: number): BlockPostState {
  return {
    id: BlockId(block.id),
    doc_id,
    type: block.type,
    parent_block_id: null,
    // Fixed-width index → lexicographically sortable; replaced by the
    // fractional-index projection job when it lands (§16.11).
    order_key: String(index).padStart(6, "0"),
    content_json: canonicalize({ props: block.props, content: block.content }),
    visibility: "default",
  };
}

export interface ApplyOpsResult {
  /** The full post-state block list — hand to `writeBlocks`. */
  readonly post: readonly Block[];
  /** Per-op audit projections, 1:1 with the input ops. */
  readonly applied: AppliedOps;
}

export async function applyOpsToBlocks(
  pre: readonly Block[],
  ops: readonly Op[],
  deps: { readonly doc_id: DocId; readonly mintId: () => string },
): Promise<ApplyOpsResult> {
  const working: Block[] = [...pre];
  const applied: AppliedOps[number][] = [];

  for (const op of ops) {
    if (op.op === "insert") {
      applied.push(applyInsert(working, op, deps));
    } else if (op.op === "update") {
      applied.push(await applyUpdate(working, op, deps.doc_id));
    } else {
      applied.push(await applyRemove(working, op, deps.doc_id));
    }
  }

  return { post: working, applied };
}

function applyInsert(
  working: Block[],
  op: InsertOp,
  deps: { readonly doc_id: DocId; readonly mintId: () => string },
): AppliedOps[number] {
  const block = materializeBlock(
    {
      type: op.block.type,
      props: parseProps(op.block.type, op.block.props ?? {}),
      content: op.block.content,
    },
    deps.mintId(),
  );
  let index: number;
  if (op.after_block_id === null) {
    index = 0; // `null` = insert at the top
  } else {
    const anchor = working.findIndex((b) => b.id === op.after_block_id);
    if (anchor === -1) {
      throw new NotFoundError({ subject_kind: "block", subject_id: op.after_block_id });
    }
    index = anchor + 1;
  }
  working.splice(index, 0, block);
  return {
    op: "insert",
    block: projectPostState(block, deps.doc_id, index),
    after_block_id: op.after_block_id,
    parent_block_id: null,
  };
}

async function applyUpdate(
  working: Block[],
  op: UpdateOp,
  doc_id: DocId,
): Promise<AppliedOps[number]> {
  const index = working.findIndex((b) => b.id === op.block_id);
  const current = working[index];
  if (current === undefined) {
    throw new NotFoundError({ subject_kind: "block", subject_id: op.block_id });
  }

  if (op.expect_prior_content_hash !== undefined) {
    const actual = await hashBlockContent(current);
    if (actual !== op.expect_prior_content_hash) {
      throw new StalePreconditionError({
        block_id: BlockId(current.id),
        expected_hash: op.expect_prior_content_hash,
        actual_hash: actual,
      });
    }
  }

  const type = op.patch.type ?? current.type;
  const repropped = op.patch.type !== undefined || op.patch.props !== undefined;
  const next: Block = {
    id: current.id,
    type,
    props: repropped ? parseProps(type, { ...current.props, ...op.patch.props }) : current.props,
    content: op.patch.content !== undefined ? normalizeContent(op.patch.content) : current.content,
    children: current.children,
  };
  working[index] = next;

  return { op: "update", block_id: op.block_id, post: projectPostState(next, doc_id, index) };
}

async function applyRemove(
  working: Block[],
  op: RemoveOp,
  doc_id: DocId,
): Promise<AppliedOps[number]> {
  const index = working.findIndex((b) => b.id === op.block_id);
  const current = working[index];
  if (current === undefined) {
    throw new NotFoundError({ subject_kind: "block", subject_id: op.block_id });
  }

  if (op.expect_prior_content_hash !== undefined) {
    const actual = await hashBlockContent(current);
    if (actual !== op.expect_prior_content_hash) {
      throw new StalePreconditionError({
        block_id: BlockId(current.id),
        expected_hash: op.expect_prior_content_hash,
        actual_hash: actual,
      });
    }
  }

  const preimage = projectPostState(current, doc_id, index);
  working.splice(index, 1);
  return { op: "remove", block_id: op.block_id, preimage };
}

// ── Diff (the client half) ──────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "";
}

/**
 * Diff `before` (the loaded server state) against `after` (the edited
 * editor state) into the wire op list that replays the change.
 *
 * `hashesById` — optional `expect_prior_content_hash` source keyed by
 * block id, computed over the *loaded* blocks (`hashBlockContent`).
 * When provided, every update/remove carries the precondition so a
 * concurrent server-side change surfaces as a 409 instead of a silent
 * clobber.
 */
export function diffBlocksToOps(
  before: readonly Block[],
  after: readonly Block[],
  hashesById?: ReadonlyMap<string, string>,
): WireOps {
  const beforeById = new Map(before.map((b) => [b.id, b]));

  // First occurrence of a known id in `after` is "the" survivor; empty,
  // unknown, and duplicate ids are inserts (ids are server-minted — a
  // duplicate can only come from an in-editor copy/paste).
  const seen = new Set<string>();
  const keptIds: string[] = [];
  const insertEntries = new Set<number>();
  after.forEach((block, i) => {
    if (block.id.length > 0 && beforeById.has(block.id) && !seen.has(block.id)) {
      seen.add(block.id);
      keptIds.push(block.id);
    } else {
      insertEntries.add(i);
    }
  });

  // Stable ids = LCS of the surviving-id sequences; kept-but-reordered
  // ids fall out and lower to remove + insert (the deferred `move` op
  // will claim them later — F33).
  const beforeSeq = before.map((b) => b.id).filter((id) => seen.has(id));
  const stable = new Set(longestCommonSubsequence(beforeSeq, keptIds));
  after.forEach((block, i) => {
    if (!insertEntries.has(i) && !stable.has(block.id)) insertEntries.add(i);
  });

  const ops: WireOps[number][] = [];

  // Updates — stable ids whose editable state changed.
  for (const [i, block] of after.entries()) {
    if (insertEntries.has(i)) continue;
    const prior = beforeById.get(block.id);
    if (prior === undefined) continue;
    const patch: { type?: string; props?: Record<string, unknown>; content?: unknown } = {};
    if (block.type !== prior.type) patch.type = block.type;
    if (canonicalJson(block.props) !== canonicalJson(prior.props)) patch.props = { ...block.props };
    if (canonicalJson(block.content) !== canonicalJson(prior.content))
      patch.content = block.content;
    if (Object.keys(patch).length === 0) continue;
    const hash = hashesById?.get(block.id);
    ops.push({
      op: "update",
      block_id: block.id,
      patch,
      ...(hash !== undefined ? { expect_prior_content_hash: hash } : {}),
    });
  }

  // Removes — gone entirely, or kept-but-not-stable (the remove half of
  // a lowered move).
  const afterIds = new Set(after.filter((b) => b.id.length > 0).map((b) => b.id));
  for (const block of before) {
    if (afterIds.has(block.id) && stable.has(block.id)) continue;
    const hash = hashesById?.get(block.id);
    ops.push({
      op: "remove",
      block_id: block.id,
      ...(hash !== undefined ? { expect_prior_content_hash: hash } : {}),
    });
  }

  // Inserts — reverse document order, each anchored to the nearest
  // preceding STABLE block (which survives every other op in this
  // batch), so stacked new blocks land in document order.
  for (let i = after.length - 1; i >= 0; i -= 1) {
    if (!insertEntries.has(i)) continue;
    const block = after[i];
    if (block === undefined) continue;
    let anchor: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = after[j];
      if (candidate !== undefined && !insertEntries.has(j) && stable.has(candidate.id)) {
        anchor = candidate.id;
        break;
      }
    }
    const content = normalizeContent(block.content);
    ops.push({
      op: "insert",
      block: {
        type: block.type,
        ...(Object.keys(block.props).length > 0 ? { props: { ...block.props } } : {}),
        ...(content.length > 0 ? { content } : {}),
      },
      after_block_id: anchor,
    });
  }

  return ops;
}

function longestCommonSubsequence(a: readonly string[], b: readonly string[]): string[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i += 1) {
    const tableRow = table[i];
    const prevRow = table[i - 1];
    if (tableRow === undefined || prevRow === undefined) continue;
    for (let j = 1; j < cols; j += 1) {
      tableRow[j] =
        a[i - 1] === b[j - 1]
          ? (prevRow[j - 1] ?? 0) + 1
          : Math.max(prevRow[j] ?? 0, tableRow[j - 1] ?? 0);
    }
  }
  const out: string[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      const id = a[i - 1];
      if (id !== undefined) out.unshift(id);
      i -= 1;
      j -= 1;
    } else if ((table[i - 1]?.[j] ?? 0) >= (table[i]?.[j - 1] ?? 0)) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return out;
}
