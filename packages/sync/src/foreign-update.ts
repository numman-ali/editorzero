/**
 * Foreign-update lane (ADR 0043 Decision 2) — apply a caller-supplied raw
 * Yjs update to a doc under the owned-namespace rules, repairing id-less
 * blocks, and return the EXACT blob the enclosing transact will persist.
 *
 * This lives in `@editorzero/sync` (not in the capability) because it is
 * Y.Doc surgery end-to-end — share-map inspection, struct-store pending
 * state, fragment parsing — and §16.1 pins this package as the sole
 * importer of Yjs internals (`no-raw-ydoc-access`). The `doc.apply_update`
 * capability composes it inside `ctx.transact`; the WS adapter (ADR 0043
 * Decision 3) reuses the same lane via the dispatcher.
 *
 * ## Contract with the broadcast-after-commit binding
 *
 * `applyForeignUpdate` MUST be the only mutation inside its transact fn.
 * It captures the clone's `update` events across apply + repair and
 * returns `Y.mergeUpdates(captured)`; the binding brackets the same fn
 * with its own listener and persists `Y.mergeUpdates(its captured)` —
 * identical event lists, identical merge, byte-identical blob. That is
 * what lets the audit effect carry the exact persisted bytes (ADR 0043
 * review MUST-FIX 2) without a second source of truth. Any extra mutation
 * in the same fn would land in the persisted blob but not in the returned
 * one.
 *
 * ## Refusals THROW; the no-op lane RETURNS
 *
 * A refusal must abort the enclosing SQL tx — by the time validation can
 * run, `Y.applyUpdate` has already mutated the clone and the binding's
 * listener has captured events; returning normally would let the binding
 * persist a refused delta. `ForeignUpdateRefusedError` propagating out of
 * the transact fn is what keeps the staging empty (the binding only
 * merges + persists on clean return). The contained no-op, by contrast,
 * fires no events at all — returning `{ applied: false }` stages nothing.
 *
 * ## Why update-event capture detects the no-op (not a state-vector diff)
 *
 * A delete-only update changes doc state without changing the state
 * vector, so `SV(before) === SV(after)` would misclassify real deletions
 * as no-ops. Yjs emits `update` exactly when a transaction changed
 * structs or the delete set — the same signal the binding persists on —
 * so "no events captured" is precisely "nothing would be persisted".
 *
 * ## Why pending structs refuse
 *
 * An update whose structs reference missing dependencies parks content in
 * `store.pendingStructs` / `pendingDs` — invisible to the share map and
 * the fragment parse, but it materializes later when the gap fills. A
 * foreign shared type or schema violation hidden in pending structs would
 * bypass every check below and surface on the resident after a future
 * apply. Unvalidatable ⇒ refused. Legitimate WS providers sync first
 * (SyncStep1/2) and never push deltas ahead of their dependency horizon;
 * the transact clone itself starts pending-free because the contiguous
 * watermark guarantees the snapshot + tx-tail is gap-free (hocuspocus.ts).
 *
 * ## Repair, not refuse (id-less blocks)
 *
 * Browser-created blocks carry `id: ""` (PM attr `id: null`) until the
 * server mints — the editor protocol's normal state for fresh inserts,
 * not an attack. The walk is recursive (blocks nest via `children`);
 * every minted id is reported so the audit effect records it (invariant
 * 3a). The repair lands as ONE `writeBlocks` — `updateYFragment` matches
 * equal children, so blocks that only gain an `id` attr keep their Yjs
 * identity and the repair delta stays minimal.
 */

import { type Block, getEditorSchema, pmDocToBlocks } from "@editorzero/blocks";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { fromBase64, toBase64 } from "lib0/buffer";
import * as Y from "yjs";

import { DOC_FRAGMENT, writeBlocks } from "./blocks";

// ── Wire helpers ─────────────────────────────────────────────────────────
//
// lib0 (yjs's own runtime substrate) does the heavy lifting — Buffer on
// Node, btoa/atob in the browser — so the helpers stay isomorphic. The
// capability's input schema guarantees well-formed padded base64, making
// `base64ToBytes` total at its call site; the WS adapter encodes raw
// frame bytes with `bytesToBase64` before dispatching.

/** Decode standard padded base64 to bytes. Caller guarantees well-formedness. */
export function base64ToBytes(value: string): Uint8Array {
  return fromBase64(value);
}

/** Encode bytes as standard padded base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  return toBase64(bytes);
}

// ── Refusals ─────────────────────────────────────────────────────────────

export type ForeignUpdateRefusalReason =
  /** `Y.applyUpdate` threw, or the update left pending structs / deletes. */
  | "not_integrable"
  /** The update materialized a top-level shared type other than the owned fragment. */
  | "foreign_shared_type"
  /** The fragment no longer parses under the owned editor schema (or is empty). */
  | "schema_violation"
  /** Two blocks in the post-apply tree carry the same non-empty id. */
  | "duplicate_block_id";

/**
 * Thrown for every refusal lane. Deliberately an Error (not a result
 * arm): the throw is what aborts the enclosing transact + SQL tx, and a
 * caller cannot forget to do it. `doc.apply_update` maps this to
 * `ValidationError` (400) with `{ reason, detail }` issues.
 */
export class ForeignUpdateRefusedError extends Error {
  readonly reason: ForeignUpdateRefusalReason;
  readonly detail: string;

  constructor(reason: ForeignUpdateRefusalReason, detail: string) {
    super(`foreign update refused (${reason}): ${detail}`);
    this.name = "ForeignUpdateRefusedError";
    this.reason = reason;
    this.detail = detail;
  }
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── Result ───────────────────────────────────────────────────────────────

export type AppliedForeignUpdate =
  | {
      /** Contained no-op: nothing changed, nothing will be persisted. */
      readonly applied: false;
      readonly update: null;
      readonly minted_block_ids: readonly string[];
    }
  | {
      readonly applied: true;
      /**
       * `Y.mergeUpdates` over every captured event (apply + repair) —
       * byte-identical to what the enclosing binding persists, per the
       * contract in the file header.
       */
      readonly update: Uint8Array;
      /** Ids minted for `id: ""` blocks, in depth-first document order. */
      readonly minted_block_ids: readonly string[];
    };

// ── The lane ─────────────────────────────────────────────────────────────

/**
 * Apply a foreign Yjs `update` to `ydoc` (the transact clone) under the
 * owned-namespace rules. Returns the no-op marker or the merged
 * post-repair blob + minted ids; throws `ForeignUpdateRefusedError` on
 * any refusal (which MUST propagate — see file header).
 *
 * `mintId` is called once per id-less block, depth-first; callers that
 * need the minted ids in their own branded type capture them in the
 * closure (the returned list is the same ids as plain strings).
 */
export function applyForeignUpdate(
  ydoc: Y.Doc,
  update: Uint8Array,
  opts: { readonly mintId: () => string },
): AppliedForeignUpdate {
  const captured: Uint8Array[] = [];
  const capture = (event: Uint8Array): void => {
    captured.push(event);
  };
  const svBefore = Y.encodeStateVector(ydoc);
  ydoc.on("update", capture);
  try {
    try {
      Y.applyUpdate(ydoc, update);
    } catch (err) {
      throw new ForeignUpdateRefusedError(
        "not_integrable",
        `Y.applyUpdate rejected the payload: ${describeThrown(err)}`,
      );
    }

    // Pending structs/deletes — content this lane cannot validate (file
    // header). The clone starts pending-free, so pending here is the
    // caller's update referencing dependencies it never sent.
    if (ydoc.store.pendingStructs !== null || ydoc.store.pendingDs !== null) {
      throw new ForeignUpdateRefusedError(
        "not_integrable",
        "update references structs/deletes the doc does not contain (pending after apply) — sync first, then send deltas",
      );
    }

    // Contained no-op: Yjs fired no update event, so the binding will
    // persist nothing. Return the marker instead of validating a
    // no-change state (ADR 0043's named no-op lane).
    if (captured.length === 0) {
      // Ambient-transaction guard (composition bug, NOT a refusal): Yjs
      // defers update events to the end of the OUTERMOST transaction, so
      // a caller that wraps this helper in `ydoc.transact` would see
      // zero events for a struct-bearing apply — silently misclassified
      // as a no-op while the doc mutated and the binding persists
      // nothing. Both sanctioned compositions (the HocuspocusSync clone
      // and MemorySyncService) hand fn a bare doc; anything else must
      // fail loudly here. (A delete-only apply leaves the state vector
      // unchanged and would evade this probe — the guard is
      // defense-in-depth, not the contract.)
      const svAfter = Y.encodeStateVector(ydoc);
      if (!bytesEqual(svBefore, svAfter)) {
        throw new Error(
          "applyForeignUpdate: the apply mutated the doc but no update event was delivered — " +
            "called inside an ambient Y transaction? Events must fire synchronously for the " +
            "no-op marker and the returned blob to be trustworthy.",
        );
      }
      return { applied: false, update: null, minted_block_ids: [] };
    }

    // Owned-namespace exactness (ADR 0043 review SHOULD-FIX 3): the only
    // top-level shared type a doc may carry is the owned fragment. Root
    // types materialize in `doc.share` during integration, so post-apply
    // keys are the complete inventory of what the update touched/created.
    const foreignKeys = [...ydoc.share.keys()].filter((key) => key !== DOC_FRAGMENT);
    if (foreignKeys.length > 0) {
      throw new ForeignUpdateRefusedError(
        "foreign_shared_type",
        `update materialized non-owned shared type(s): ${foreignKeys.join(", ")}`,
      );
    }

    // Structural check under the owned editor schema. An empty fragment
    // after a real (event-bearing) apply means the update deleted every
    // block — the doc schema is `block+`, so that state is unwritable by
    // the owned lane and unreadable by `doc.get`; refuse it.
    const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
    if (fragment.length === 0) {
      throw new ForeignUpdateRefusedError(
        "schema_violation",
        "update left the doc with zero top-level blocks — the doc schema is `block+`",
      );
    }

    // **Heal detection.** `@tiptap/y-tiptap@3.0.4` does NOT throw on
    // content the schema can't represent — `createNodeFromYElement` /
    // `createTextNodesFromYText` catch the schema error, DELETE the
    // offending element from the Y.Doc ("probably a result of a
    // concurrent action"), and continue (verified against the installed
    // dist). A parse-throw check alone would therefore let a junk insert
    // through as "valid minus the junk" — a silent mutation of caller
    // content, persisted via the captured heal-deletion event. The parse
    // is read-only on representable content, so ANY update event fired
    // while it runs is the heal — and the refusal condition.
    let healed = false;
    const detectHeal = (): void => {
      healed = true;
    };
    ydoc.on("update", detectHeal);
    let blocks: Block[];
    try {
      const node = yXmlFragmentToProseMirrorRootNode(fragment, getEditorSchema());
      node.check();
      blocks = pmDocToBlocks(node.toJSON());
    } catch (err) {
      throw new ForeignUpdateRefusedError("schema_violation", describeThrown(err));
    } finally {
      ydoc.off("update", detectHeal);
    }
    if (healed) {
      throw new ForeignUpdateRefusedError(
        "schema_violation",
        "update contains content the owned editor schema cannot represent (the parse had to drop nodes)",
      );
    }

    // Non-empty ids must be unique across the whole tree — `doc.update`
    // addresses blocks by id, and a duplicate would make ops ambiguous.
    const duplicate = findDuplicateId(blocks, new Set());
    if (duplicate !== undefined) {
      throw new ForeignUpdateRefusedError(
        "duplicate_block_id",
        `block id ${duplicate} appears more than once in the post-apply tree`,
      );
    }

    // Repair: mint ids for `id: ""` blocks and land them as ONE
    // writeBlocks. The capture listener is still attached, so the repair
    // event merges into the returned blob (and the binding's).
    const minted: string[] = [];
    const repaired = mintMissingIds(blocks, opts.mintId, minted);
    if (minted.length > 0) {
      writeBlocks(ydoc, repaired);
    }

    return { applied: true, update: Y.mergeUpdates(captured), minted_block_ids: minted };
  } finally {
    ydoc.off("update", capture);
  }
}

/** Depth-first scan for a repeated non-empty id; returns the first offender. */
function findDuplicateId(blocks: readonly Block[], seen: Set<string>): string | undefined {
  for (const block of blocks) {
    if (block.id.length > 0) {
      if (seen.has(block.id)) return block.id;
      seen.add(block.id);
    }
    const nested = findDuplicateId(block.children, seen);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** Copy the tree, minting an id for every `id: ""` block (depth-first). */
function mintMissingIds(blocks: readonly Block[], mintId: () => string, minted: string[]): Block[] {
  return blocks.map((block) => {
    const id = block.id.length === 0 ? mintId() : block.id;
    if (id !== block.id) {
      minted.push(id);
    }
    return { ...block, id, children: mintMissingIds(block.children, mintId, minted) };
  });
}
