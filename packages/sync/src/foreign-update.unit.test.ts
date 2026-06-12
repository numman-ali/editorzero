/**
 * `applyForeignUpdate` — the foreign-update lane (ADR 0043 Decision 2).
 *
 * Every lane has a pin here: the happy path (novel delta applies and the
 * returned blob is replay-faithful), the contained no-op, every refusal
 * reason (`not_integrable` ×2, `foreign_shared_type`,
 * `schema_violation` ×3, `duplicate_block_id`), and the id-repair path
 * (minted ids land in the SAME returned blob — replaying it on a
 * pristine twin reproduces the post-repair state byte-for-byte, the
 * MUST-FIX 2 guarantee the audit effect leans on).
 *
 * The y-tiptap HEAL behavior gets its own pin: `@tiptap/y-tiptap@3.0.4`
 * deletes schema-unrepresentable elements during the read instead of
 * throwing (verified against the installed dist — see foreign-update.ts).
 * If a future bump changes that to a throw, the refusal stays
 * `schema_violation` either way and these tests keep passing; if a bump
 * made the parse SILENTLY accept junk, the heal pin fails loudly.
 *
 * Deltas are built the way a real Yjs client builds them: fork a twin
 * doc from the target's state, mutate the twin, and encode against the
 * pre-mutation state vector.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { DOC_FRAGMENT, readBlocks, type SeedBlock, seedBlocks, writeBlocks } from "./blocks";
import {
  applyForeignUpdate,
  base64ToBytes,
  bytesToBase64,
  ForeignUpdateRefusedError,
} from "./foreign-update";

const BLOCK_TITLE = "018f0000-0000-7000-8000-00000000b001";
const BLOCK_BODY = "018f0000-0000-7000-8000-00000000b002";

let nextId = 0;
function mintTestId(): string {
  nextId += 1;
  return `018f0000-0000-7000-8000-${String(nextId).padStart(12, "0")}`;
}

const SEEDS: SeedBlock[] = [
  { id: BLOCK_TITLE, type: "heading", props: { level: 1 }, content: "Title" },
  { id: BLOCK_BODY, type: "paragraph", content: "Body" },
];

/** A target doc seeded with the canonical two blocks. */
function seededDoc(): Y.Doc {
  const ydoc = new Y.Doc();
  seedBlocks(ydoc, SEEDS);
  return ydoc;
}

/** Fork a twin carrying exactly the target's current state. */
function fork(target: Y.Doc): Y.Doc {
  const twin = new Y.Doc();
  Y.applyUpdate(twin, Y.encodeStateAsUpdate(target));
  return twin;
}

/** Encode the twin's changes since `sv` — what a provider would send. */
function deltaSince(twin: Y.Doc, sv: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(twin, sv);
}

function refusalOf(fn: () => unknown): ForeignUpdateRefusedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ForeignUpdateRefusedError) return err;
    throw err;
  }
  throw new Error("expected ForeignUpdateRefusedError");
}

function blockTexts(ydoc: Y.Doc): string[] {
  return readBlocks(ydoc).map((b) =>
    b.content.map((run) => (typeof run.text === "string" ? run.text : "")).join(""),
  );
}

describe("applyForeignUpdate — happy path", () => {
  it("applies a novel well-formed delta and returns a replay-faithful merged blob", () => {
    const target = seededDoc();
    const pristineTwin = fork(target); // for replay verification below

    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    const blocks = readBlocks(editor);
    writeBlocks(
      editor,
      blocks.map((b) =>
        b.id === BLOCK_BODY
          ? { ...b, content: [{ type: "text" as const, text: "Edited body", styles: {} }] }
          : b,
      ),
    );
    const delta = deltaSince(editor, sv);

    const result = applyForeignUpdate(target, delta, { mintId: mintTestId });

    expect(result.applied).toBe(true);
    expect(result.minted_block_ids).toEqual([]);
    expect(blockTexts(target)).toEqual(["Title", "Edited body"]);

    // MUST-FIX 2 faithfulness: the returned blob alone carries the
    // mutation — replaying it on a pristine twin converges to the target.
    if (result.applied) {
      Y.applyUpdate(pristineTwin, result.update);
      expect(Array.from(Y.encodeStateVector(pristineTwin))).toEqual(
        Array.from(Y.encodeStateVector(target)),
      );
      expect(blockTexts(pristineTwin)).toEqual(["Title", "Edited body"]);
    }
  });

  it("applies a delete-only delta (state changes; the state vector does not)", () => {
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    writeBlocks(
      editor,
      readBlocks(editor).filter((b) => b.id !== BLOCK_BODY),
    );
    const delta = deltaSince(editor, sv);

    const result = applyForeignUpdate(target, delta, { mintId: mintTestId });

    // A state-vector-diff no-op detector would misclassify this delta as
    // contained; the event-capture detector must not.
    expect(result.applied).toBe(true);
    expect(readBlocks(target).map((b) => b.id)).toEqual([BLOCK_TITLE]);
  });

  it("returns the contained no-op marker for an already-applied delta", () => {
    const target = seededDoc();
    const contained = Y.encodeStateAsUpdate(target);

    const result = applyForeignUpdate(target, contained, { mintId: mintTestId });

    expect(result.applied).toBe(false);
    expect(result.update).toBeNull();
    expect(result.minted_block_ids).toEqual([]);
    expect(blockTexts(target)).toEqual(["Title", "Body"]);
  });

  it("treats an empty-doc update as the contained no-op", () => {
    const target = seededDoc();
    const empty = Y.encodeStateAsUpdate(new Y.Doc());

    const result = applyForeignUpdate(target, empty, { mintId: mintTestId });

    expect(result.applied).toBe(false);
  });
});

describe("applyForeignUpdate — id repair", () => {
  it("mints ids for id-less blocks and folds the repair into the returned blob", () => {
    const target = seededDoc();
    const pristineTwin = fork(target);

    // A browser-fresh insert: paragraph with NO id attribute (PM attr
    // id: null never reaches the Yjs element).
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    const el = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "fresh from the browser");
    el.insert(0, [text]);
    editor.getXmlFragment(DOC_FRAGMENT).insert(2, [el]);
    const delta = deltaSince(editor, sv);

    const result = applyForeignUpdate(target, delta, { mintId: mintTestId });

    expect(result.applied).toBe(true);
    expect(result.minted_block_ids).toHaveLength(1);
    const minted = result.minted_block_ids[0];

    // The target's fragment now carries the minted id (readBlocks would
    // throw on an id-less persisted block — repair made it readable).
    const ids = readBlocks(target).map((b) => b.id);
    expect(ids).toEqual([BLOCK_TITLE, BLOCK_BODY, minted]);

    // Replay faithfulness INCLUDING the repair: the returned blob carries
    // apply + mint as one unit.
    if (result.applied) {
      Y.applyUpdate(pristineTwin, result.update);
      expect(readBlocks(pristineTwin).map((b) => b.id)).toEqual([BLOCK_TITLE, BLOCK_BODY, minted]);
    }
  });

  it("repairs multiple id-less blocks in document order, preserving surviving ids", () => {
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    const fragment = editor.getXmlFragment(DOC_FRAGMENT);
    const first = new Y.XmlElement("paragraph");
    const firstText = new Y.XmlText();
    firstText.insert(0, "one");
    first.insert(0, [firstText]);
    const second = new Y.XmlElement("paragraph");
    const secondText = new Y.XmlText();
    secondText.insert(0, "two");
    second.insert(0, [secondText]);
    fragment.insert(2, [first, second]);
    const delta = deltaSince(editor, sv);

    const result = applyForeignUpdate(target, delta, { mintId: mintTestId });

    expect(result.applied).toBe(true);
    expect(result.minted_block_ids).toHaveLength(2);
    const ids = readBlocks(target).map((b) => b.id);
    expect(ids).toEqual([BLOCK_TITLE, BLOCK_BODY, ...result.minted_block_ids]);
    expect(blockTexts(target)).toEqual(["Title", "Body", "one", "two"]);
  });
});

describe("applyForeignUpdate — refusals", () => {
  it("refuses garbage bytes as not_integrable", () => {
    const target = seededDoc();
    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42]);

    const refusal = refusalOf(() => applyForeignUpdate(target, garbage, { mintId: mintTestId }));
    expect(refusal.reason).toBe("not_integrable");
  });

  it("refuses a delta with missing dependencies (pending structs) as not_integrable", () => {
    const target = seededDoc();
    const editor = fork(target);
    // Two sequential edits on the twin; send ONLY the second — its
    // structs reference the first edit's items, which the target lacks.
    writeBlocks(
      editor,
      readBlocks(editor).map((b) =>
        b.id === BLOCK_BODY
          ? { ...b, content: [{ type: "text" as const, text: "edit one", styles: {} }] }
          : b,
      ),
    );
    const svAfterFirst = Y.encodeStateVector(editor);
    writeBlocks(
      editor,
      readBlocks(editor).map((b) =>
        b.id === BLOCK_BODY
          ? { ...b, content: [{ type: "text" as const, text: "edit two", styles: {} }] }
          : b,
      ),
    );
    const secondOnly = deltaSince(editor, svAfterFirst);

    const refusal = refusalOf(() => applyForeignUpdate(target, secondOnly, { mintId: mintTestId }));
    expect(refusal.reason).toBe("not_integrable");
    expect(refusal.detail).toMatch(/pending/);
  });

  it("refuses an update materializing a non-owned shared type as foreign_shared_type", () => {
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    editor.getMap("evil").set("payload", "smuggled");
    const delta = deltaSince(editor, sv);

    const refusal = refusalOf(() => applyForeignUpdate(target, delta, { mintId: mintTestId }));
    expect(refusal.reason).toBe("foreign_shared_type");
    expect(refusal.detail).toContain("evil");
  });

  it("refuses a foreign type even when valid fragment content rides along", () => {
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    writeBlocks(
      editor,
      readBlocks(editor).map((b) =>
        b.id === BLOCK_BODY
          ? { ...b, content: [{ type: "text" as const, text: "legit edit", styles: {} }] }
          : b,
      ),
    );
    editor.getText("aside").insert(0, "smuggled");
    const delta = deltaSince(editor, sv);

    const refusal = refusalOf(() => applyForeignUpdate(target, delta, { mintId: mintTestId }));
    expect(refusal.reason).toBe("foreign_shared_type");
  });

  it("refuses an update that empties the fragment as schema_violation (block+)", () => {
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    const fragment = editor.getXmlFragment(DOC_FRAGMENT);
    fragment.delete(0, fragment.length);
    const delta = deltaSince(editor, sv);

    const refusal = refusalOf(() => applyForeignUpdate(target, delta, { mintId: mintTestId }));
    expect(refusal.reason).toBe("schema_violation");
    expect(refusal.detail).toMatch(/block\+/);
  });

  it("refuses an unknown element type as schema_violation (the y-tiptap heal pin)", () => {
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    const alien = new Y.XmlElement("blink");
    alien.setAttribute("id", mintTestId());
    editor.getXmlFragment(DOC_FRAGMENT).insert(2, [alien]);
    const delta = deltaSince(editor, sv);

    // y-tiptap 3.0.4 would DELETE the alien element during the read and
    // carry on — the heal-detection listener must catch that and refuse
    // rather than persist "the caller's update minus the junk".
    const refusal = refusalOf(() => applyForeignUpdate(target, delta, { mintId: mintTestId }));
    expect(refusal.reason).toBe("schema_violation");
  });

  it("refuses a duplicate non-empty block id as duplicate_block_id", () => {
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    const dupe = new Y.XmlElement("paragraph");
    dupe.setAttribute("id", BLOCK_BODY); // collides with the seeded body
    const text = new Y.XmlText();
    text.insert(0, "imposter");
    dupe.insert(0, [text]);
    editor.getXmlFragment(DOC_FRAGMENT).insert(2, [dupe]);
    const delta = deltaSince(editor, sv);

    const refusal = refusalOf(() => applyForeignUpdate(target, delta, { mintId: mintTestId }));
    expect(refusal.reason).toBe("duplicate_block_id");
    expect(refusal.detail).toContain(BLOCK_BODY);
  });

  it("refuses an update that replaces every block with aliens (check() throws on empty doc)", () => {
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    const fragment = editor.getXmlFragment(DOC_FRAGMENT);
    fragment.delete(0, fragment.length);
    const alien = new Y.XmlElement("marquee");
    alien.setAttribute("id", mintTestId());
    fragment.insert(0, [alien]);
    const delta = deltaSince(editor, sv);

    // The fragment is non-empty (one alien), so the empty-check passes;
    // the parse heals the alien away, leaving a zero-child doc that
    // fails ProseMirror's `block+` content check — the throw lane of
    // the structural gate.
    const refusal = refusalOf(() => applyForeignUpdate(target, delta, { mintId: mintTestId }));
    expect(refusal.reason).toBe("schema_violation");
  });

  it("throws loudly (not a refusal) when called inside an ambient Y transaction", () => {
    // Yjs defers update events to the outermost transaction's end, so a
    // wrapped call would misclassify a struct-bearing apply as a no-op
    // while the doc mutated underneath. The guard turns that silent
    // hazard into a composition error.
    const target = seededDoc();
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    writeBlocks(
      editor,
      readBlocks(editor).map((b) =>
        b.id === BLOCK_BODY
          ? { ...b, content: [{ type: "text" as const, text: "wrapped", styles: {} }] }
          : b,
      ),
    );
    const delta = deltaSince(editor, sv);

    expect(() => {
      target.transact(() => {
        applyForeignUpdate(target, delta, { mintId: mintTestId });
      });
    }).toThrow(/ambient Y transaction/);
  });

  it("detaches its capture listener on the refusal path (no observer leak)", () => {
    const target = seededDoc();
    const garbage = new Uint8Array([0x00, 0x01]);
    refusalOf(() => applyForeignUpdate(target, garbage, { mintId: mintTestId }));

    // A leaked listener would re-capture this unrelated mutation and a
    // second call would return a blob containing it; instead the doc
    // behaves as fresh.
    const editor = fork(target);
    const sv = Y.encodeStateVector(target);
    writeBlocks(
      editor,
      readBlocks(editor).map((b) =>
        b.id === BLOCK_BODY
          ? { ...b, content: [{ type: "text" as const, text: "after refusal", styles: {} }] }
          : b,
      ),
    );
    const result = applyForeignUpdate(target, deltaSince(editor, sv), { mintId: mintTestId });
    expect(result.applied).toBe(true);
    expect(blockTexts(target)).toEqual(["Title", "after refusal"]);
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 42]);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encoded.length % 4).toBe(0);
    expect(Array.from(base64ToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it("round-trips a real Yjs update blob", () => {
    const target = seededDoc();
    const blob = Y.encodeStateAsUpdate(target);
    const decoded = base64ToBytes(bytesToBase64(blob));
    expect(Array.from(decoded)).toEqual(Array.from(blob));
    const replay = new Y.Doc();
    Y.applyUpdate(replay, decoded);
    expect(readBlocks(replay).map((b) => b.id)).toEqual([BLOCK_TITLE, BLOCK_BODY]);
  });
});
