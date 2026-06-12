/**
 * Owned block layer ⇄ Y.Doc bridge (ADR 0038, architecture.md §16.1 / ADR 0018).
 *
 * DOM-free in BOTH directions — this file is where ADR 0038's
 * load-bearing pay-off lands. Reads go `Y.XmlFragment →
 * yXmlFragmentToProseMirrorRootNode(fragment, schema) → toJSON() →
 * pmDocToBlocks`; writes go `blocksToPmDoc → Node.fromJSON(schema) →
 * updateYFragment`. No live editor, no `view.dispatch`, no happy-dom:
 * the pre-0038 BlockNote path needed a mounted editor (and a DOM shim
 * in the production trunk) for every mutation; `updateYFragment` is
 * the y-prosemirror primitive that diffs a ProseMirror doc against
 * the fragment in place.
 *
 * `updateYFragment` semantics that this design leans on (verified
 * against `@tiptap/y-tiptap@3.0.4` source):
 *
 *   - It wraps all child reconciliation in ONE `ydoc.transact` (the
 *     recursive calls join the outer transaction), so a `writeBlocks`
 *     inside the dispatcher's write-path tx produces exactly one
 *     Yjs update event → one `doc_updates` row (§6.5's contract).
 *   - Children that compare equal (node name + attrs + content) are
 *     matched, not rewritten — untouched blocks keep their Yjs
 *     history/identity, so a one-block edit doesn't churn the doc.
 *   - Its postcondition is Y-state ≡ the given PM doc; within a
 *     changed region it may morph a same-named element rather than
 *     splice (granularity affects update size, never the result).
 *
 * The doc schema requires ≥ 1 block (`block+`): `writeBlocks` rejects
 * an empty post-state with a clear error instead of letting
 * ProseMirror's `check()` throw a cryptic one. Read-side, an empty
 * fragment (doc never seeded) returns `[]` — `doc.get` fails closed
 * on that upstream.
 *
 * `DOC_FRAGMENT` is the Y.XmlFragment name reads and writes must
 * agree on. The string predates ADR 0038 (it was the BlockNote
 * binding's fragment name) and is part of the durable format — do not
 * rename the VALUE without a content migration.
 */

import {
  type Block,
  blocksToPmDoc,
  getEditorSchema,
  materializeBlock,
  type PartialBlockInput,
  pmDocToBlocks,
} from "@editorzero/blocks";
import { Node as PmNode } from "@tiptap/pm/model";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

export const DOC_FRAGMENT = "document-store";

/** A seed block: caller-supplied (pre-minted) id is mandatory — audit
 * invariant 3a records every seeded block id. */
export type SeedBlock = PartialBlockInput & { readonly id: string };

/**
 * Read the canonical block list from the Y.Doc's fragment. Pure
 * projection from CRDT state. Persisted blocks always carry minted
 * ids; an id-less block here means the store was written outside the
 * owned write path — fail loud rather than hand the caller a block
 * that can't be addressed by `doc.update`.
 */
export function readBlocks(ydoc: Y.Doc): Block[] {
  const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
  if (fragment.length === 0) return [];
  const node = yXmlFragmentToProseMirrorRootNode(fragment, getEditorSchema());
  const blocks = pmDocToBlocks(node.toJSON());
  for (const block of blocks) {
    if (block.id.length === 0) {
      throw new Error(
        "readBlocks: persisted block without an id — the fragment was written outside the owned write path.",
      );
    }
  }
  return blocks;
}

/**
 * Make the Y.Doc's fragment equal `blocks`. One Yjs transaction, one
 * update event. Callers hand the FULL post-state (the op applier's
 * output) — this is a state write, not a patch.
 */
export function writeBlocks(ydoc: Y.Doc, blocks: readonly Block[]): void {
  if (blocks.length === 0) {
    throw new Error(
      "writeBlocks: post-state must contain at least one block — the doc schema is `block+`.",
    );
  }
  const schema = getEditorSchema();
  const node = PmNode.fromJSON(schema, blocksToPmDoc(blocks));
  node.check();
  const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
  updateYFragment(ydoc, fragment, node, { mapping: new Map(), isOMark: new Map() });
}

/**
 * First-time seed (e.g. `doc.create` writing title + trailing
 * paragraph). Refuses a non-empty fragment: seeding is import-for-
 * first-time-only; updates flow through `readBlocks` → op applier →
 * `writeBlocks`.
 */
export function seedBlocks(ydoc: Y.Doc, seeds: readonly SeedBlock[]): void {
  const fragment = ydoc.getXmlFragment(DOC_FRAGMENT);
  if (fragment.length > 0) {
    throw new Error(
      "seedBlocks: refusing to seed a non-empty Y.XmlFragment — seeding is first-time-only; use the op applier + writeBlocks for updates.",
    );
  }
  writeBlocks(
    ydoc,
    seeds.map((seed) => materializeBlock(seed, seed.id)),
  );
}
