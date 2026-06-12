/**
 * `doc.update` op semantics — applier + diff unit tests, and the law
 * that ties them: `applyOpsToBlocks(before, diffBlocksToOps(before,
 * after)) ≡ after` (modulo server-minted insert ids), swept over
 * seeded random before/after pairs. That property is exactly the
 * HTTP-first editor's correctness contract: whatever the browser diff
 * emits, the server applier reconstructs the editor's post-state.
 */

import { NotFoundError, StalePreconditionError } from "@editorzero/errors";
import { BlockId, DocId } from "@editorzero/ids";
import { DocUpdateInputSchema } from "@editorzero/schemas/doc/update";
import { describe, expect, it } from "vitest";

import { hashBlockContent } from "./hash";
import type { Block, StyledText } from "./model";
import { applyOpsToBlocks, diffBlocksToOps } from "./ops";

const DOC = DocId("018f0000-0000-7000-8000-0000000000d1");
const MISSING = BlockId("018f0000-0000-7000-8000-00000000dead");

let minted = 0;
function mintId(): string {
  minted += 1;
  return `018f0000-0000-7000-8000-${String(minted).padStart(12, "0")}`;
}

function run(text: string, styles: StyledText["styles"] = {}): StyledText {
  return { type: "text", text, styles };
}

function paragraph(id: string, content: StyledText[]): Block {
  return { id, type: "paragraph", props: {}, content, children: [] };
}

function heading(id: string, level: number, content: StyledText[]): Block {
  return { id, type: "heading", props: { level }, content, children: [] };
}

const B1 = BlockId("018f0000-0000-7000-8000-0000000000b1");
const B2 = BlockId("018f0000-0000-7000-8000-0000000000b2");
const B3 = BlockId("018f0000-0000-7000-8000-0000000000b3");

function basicDoc(): Block[] {
  return [heading(B1, 1, [run("Title")]), paragraph(B2, [run("Body")]), paragraph(B3, [])];
}

describe("applyOpsToBlocks — insert", () => {
  it("inserts at the top when after_block_id is null", async () => {
    const { post, applied } = await applyOpsToBlocks(
      basicDoc(),
      [{ op: "insert", block: { type: "paragraph", content: "first!" }, after_block_id: null }],
      { doc_id: DOC, mintId },
    );
    expect(post.map((b) => b.id)).toEqual([post[0]?.id, B1, B2, B3]);
    expect(post[0]?.content).toEqual([run("first!")]);
    const op = applied[0];
    if (op?.op !== "insert") throw new Error("expected insert");
    expect(op.block.id).toBe(post[0]?.id);
    expect(op.block.order_key).toBe("000000");
    expect(op.after_block_id).toBeNull();
    expect(op.parent_block_id).toBeNull();
  });

  it("inserts after the anchor and applies the type's attribute defaults", async () => {
    const { post, applied } = await applyOpsToBlocks(
      basicDoc(),
      [{ op: "insert", block: { type: "heading", content: "H" }, after_block_id: B2 }],
      { doc_id: DOC, mintId },
    );
    expect(post).toHaveLength(4);
    expect(post[2]?.type).toBe("heading");
    // level defaulted by headingAttributes — applier and editor agree
    expect(post[2]?.props).toEqual({ level: 1 });
    const op = applied[0];
    if (op?.op !== "insert") throw new Error("expected insert");
    expect(op.block.order_key).toBe("000002");
    expect(op.block.content_json).toEqual({
      props: { level: 1 },
      content: [{ styles: {}, text: "H", type: "text" }],
    });
  });

  it("strips unknown props via the attribute schema (parity with the editor)", async () => {
    const { post } = await applyOpsToBlocks(
      basicDoc(),
      [
        {
          op: "insert",
          block: { type: "paragraph", props: { textColor: "red" }, content: "x" },
          after_block_id: null,
        },
      ],
      { doc_id: DOC, mintId },
    );
    expect(post[0]?.props).toEqual({});
  });

  it("throws NotFoundError(block) for a missing anchor", async () => {
    await expect(
      applyOpsToBlocks(
        basicDoc(),
        [{ op: "insert", block: { type: "paragraph" }, after_block_id: MISSING }],
        { doc_id: DOC, mintId },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws on an unsupported block type", async () => {
    await expect(
      applyOpsToBlocks(
        basicDoc(),
        [{ op: "insert", block: { type: "table" }, after_block_id: null }],
        { doc_id: DOC, mintId },
      ),
    ).rejects.toThrow(/unsupported block type "table"/);
  });
});

describe("applyOpsToBlocks — update", () => {
  it("replaces content only, leaving props untouched (no reparse)", async () => {
    const { post, applied } = await applyOpsToBlocks(
      [heading(B1, 3, [run("Old")])],
      [{ op: "update", block_id: B1, patch: { content: "New" } }],
      { doc_id: DOC, mintId },
    );
    expect(post[0]).toEqual(heading(B1, 3, [run("New")]));
    const op = applied[0];
    if (op?.op !== "update") throw new Error("expected update");
    expect(op.post.id).toBe(B1);
    expect(op.post.order_key).toBe("000000");
  });

  it("shallow-merges props patches through the type's schema", async () => {
    const { post } = await applyOpsToBlocks(
      [heading(B1, 2, [run("T")])],
      [{ op: "update", block_id: B1, patch: { props: { level: 5 } } }],
      { doc_id: DOC, mintId },
    );
    expect(post[0]?.props).toEqual({ level: 5 });
  });

  it("retypes paragraph → heading, gaining the level default", async () => {
    const { post } = await applyOpsToBlocks(
      basicDoc(),
      [{ op: "update", block_id: B2, patch: { type: "heading" } }],
      { doc_id: DOC, mintId },
    );
    expect(post[1]?.type).toBe("heading");
    expect(post[1]?.props).toEqual({ level: 1 });
    expect(post[1]?.content).toEqual([run("Body")]); // content untouched
  });

  it("retypes heading → paragraph, stripping the alien level prop", async () => {
    const { post } = await applyOpsToBlocks(
      basicDoc(),
      [{ op: "update", block_id: B1, patch: { type: "paragraph" } }],
      { doc_id: DOC, mintId },
    );
    expect(post[0]?.type).toBe("paragraph");
    expect(post[0]?.props).toEqual({});
  });

  it("honours a matching expect_prior_content_hash and rejects a stale one", async () => {
    const doc = basicDoc();
    const block = doc[1];
    if (block === undefined) throw new Error("fixture");
    const goodHash = await hashBlockContent(block);

    const ok = await applyOpsToBlocks(
      doc,
      [
        {
          op: "update",
          block_id: B2,
          patch: { content: "edited" },
          expect_prior_content_hash: goodHash,
        },
      ],
      { doc_id: DOC, mintId },
    );
    expect(ok.post[1]?.content).toEqual([run("edited")]);

    await expect(
      applyOpsToBlocks(
        basicDoc(),
        [
          {
            op: "update",
            block_id: B2,
            patch: { content: "clobber" },
            expect_prior_content_hash: "0".repeat(64),
          },
        ],
        { doc_id: DOC, mintId },
      ),
    ).rejects.toBeInstanceOf(StalePreconditionError);
  });

  it("throws NotFoundError(block) for a missing target", async () => {
    await expect(
      applyOpsToBlocks(basicDoc(), [{ op: "update", block_id: MISSING, patch: { content: "x" } }], {
        doc_id: DOC,
        mintId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("applyOpsToBlocks — remove", () => {
  it("removes the block and captures the preimage at its pre-removal index", async () => {
    const { post, applied } = await applyOpsToBlocks(basicDoc(), [{ op: "remove", block_id: B2 }], {
      doc_id: DOC,
      mintId,
    });
    expect(post.map((b) => b.id)).toEqual([B1, B3]);
    const op = applied[0];
    if (op?.op !== "remove") throw new Error("expected remove");
    expect(op.preimage.id).toBe(B2);
    expect(op.preimage.order_key).toBe("000001");
    expect(op.preimage.content_json).toEqual({
      props: {},
      content: [{ styles: {}, text: "Body", type: "text" }],
    });
  });

  it("enforces the hash precondition", async () => {
    await expect(
      applyOpsToBlocks(
        basicDoc(),
        [{ op: "remove", block_id: B2, expect_prior_content_hash: "0".repeat(64) }],
        { doc_id: DOC, mintId },
      ),
    ).rejects.toBeInstanceOf(StalePreconditionError);
  });

  it("throws NotFoundError(block) for a missing target", async () => {
    await expect(
      applyOpsToBlocks(basicDoc(), [{ op: "remove", block_id: MISSING }], { doc_id: DOC, mintId }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("applies a batch sequentially (later ops see earlier ops' state)", async () => {
    const { post } = await applyOpsToBlocks(
      basicDoc(),
      [
        { op: "remove", block_id: B2 },
        { op: "insert", block: { type: "paragraph", content: "after B1" }, after_block_id: B1 },
        { op: "update", block_id: B3, patch: { content: "tail edited" } },
      ],
      { doc_id: DOC, mintId },
    );
    expect(post.map((b) => b.content)).toEqual([
      [run("Title")],
      [run("after B1")],
      [run("tail edited")],
    ]);
  });
});

describe("diffBlocksToOps", () => {
  it("emits no ops when nothing changed", () => {
    expect(diffBlocksToOps(basicDoc(), basicDoc())).toEqual([]);
  });

  it("emits a content-only update with the precondition hash when provided", async () => {
    const before = basicDoc();
    const block = before[1];
    if (block === undefined) throw new Error("fixture");
    const hash = await hashBlockContent(block);
    const after = before.map((b, i) => (i === 1 ? { ...b, content: [run("edited")] } : b));

    const ops = diffBlocksToOps(before, after, new Map([[B2, hash]]));
    expect(ops).toEqual([
      {
        op: "update",
        block_id: B2,
        patch: { content: [run("edited")] },
        expect_prior_content_hash: hash,
      },
    ]);
  });

  it("emits patch fields only for what changed (type / props / content)", () => {
    const before = [heading(B1, 2, [run("T")])];
    const after = [{ ...heading(B1, 3, [run("T")]) }];
    expect(diffBlocksToOps(before, after)).toEqual([
      { op: "update", block_id: B1, patch: { props: { level: 3 } } },
    ]);
  });

  it("emits removes for blocks gone from the after-state", () => {
    const before = basicDoc();
    const after = [before[0], before[2]].filter((b): b is Block => b !== undefined);
    expect(diffBlocksToOps(before, after)).toEqual([{ op: "remove", block_id: B2 }]);
  });

  it("anchors consecutive inserts to the same stable block in reverse order", () => {
    const before = basicDoc();
    const after = [
      ...before.slice(0, 2),
      paragraph("", [run("new A")]),
      paragraph("", [run("new B")]),
      ...before.slice(2),
    ];
    const ops = diffBlocksToOps(before, after);
    // Reverse document order: B first (after B2), then A (after B2) —
    // applying sequentially lands A before B.
    expect(ops).toEqual([
      { op: "insert", block: { type: "paragraph", content: [run("new B")] }, after_block_id: B2 },
      { op: "insert", block: { type: "paragraph", content: [run("new A")] }, after_block_id: B2 },
    ]);
  });

  it("anchors a leading insert to null (top)", () => {
    const before = basicDoc();
    const after = [paragraph("", [run("intro")]), ...before];
    expect(diffBlocksToOps(before, after)).toEqual([
      { op: "insert", block: { type: "paragraph", content: [run("intro")] }, after_block_id: null },
    ]);
  });

  it("lowers a reorder to remove + insert (move op is deferred)", () => {
    const before = basicDoc();
    const after = [before[1], before[0], before[2]].filter((b): b is Block => b !== undefined);
    const ops = diffBlocksToOps(before, after);
    const kinds = ops.map((o) => o.op).sort();
    expect(kinds).toEqual(["insert", "remove"]);
  });

  it("treats a duplicated id (in-editor copy/paste) as an insert", () => {
    const before = [paragraph(B1, [run("x")])];
    const after = [paragraph(B1, [run("x")]), paragraph(B1, [run("x")])];
    expect(diffBlocksToOps(before, after)).toEqual([
      { op: "insert", block: { type: "paragraph", content: [run("x")] }, after_block_id: B1 },
    ]);
  });

  it("strips an unknown non-empty id (cross-doc paste) into a plain insert", () => {
    const before = [paragraph(B1, [run("x")])];
    const after = [paragraph(B1, [run("x")]), heading("alien-id", 2, [run("pasted")])];
    expect(diffBlocksToOps(before, after)).toEqual([
      {
        op: "insert",
        block: { type: "heading", props: { level: 2 }, content: [run("pasted")] },
        after_block_id: B1,
      },
    ]);
  });
});

// ── The law: apply ∘ diff ≡ identity (modulo minted insert ids) ──────────

function prng(seedInit: number): () => number {
  let seed = seedInit;
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick: empty");
  return item;
}

function genCanonicalBlock(rand: () => number, id: string): Block {
  const styleSets: StyledText["styles"][] = [{}, { bold: true }, { italic: true }, { code: true }];
  const texts = ["a", "bb", "hello", "Zwölf ✓"];
  const runs: StyledText[] = [];
  const runCount = Math.floor(rand() * 3);
  let last = -1;
  for (let r = 0; r < runCount; r += 1) {
    let idx = Math.floor(rand() * styleSets.length);
    if (idx === last) idx = (idx + 1) % styleSets.length;
    last = idx;
    runs.push(run(pick(rand, texts), styleSets[idx] ?? {}));
  }
  return rand() < 0.35 ? heading(id, 1 + Math.floor(rand() * 6), runs) : paragraph(id, runs);
}

/** Random canonical edit of a block list: edits, removes, inserts, reorders. */
function mutate(rand: () => number, before: readonly Block[]): Block[] {
  let after: Block[] = before.map((b) => ({ ...b }));
  // removes
  after = after.filter(() => rand() >= 0.2);
  // content/props/type edits
  after = after.map((b) => {
    const roll = rand();
    if (roll < 0.25) return genCanonicalBlock(rand, b.id); // full edit, id kept
    return b;
  });
  // inserts (unminted)
  const insertCount = Math.floor(rand() * 3);
  for (let i = 0; i < insertCount; i += 1) {
    const at = Math.floor(rand() * (after.length + 1));
    after.splice(at, 0, genCanonicalBlock(rand, ""));
  }
  // occasional adjacent swap (reorder)
  if (after.length >= 2 && rand() < 0.3) {
    const at = Math.floor(rand() * (after.length - 1));
    const a = after[at];
    const b = after[at + 1];
    if (a !== undefined && b !== undefined) {
      after[at] = b;
      after[at + 1] = a;
    }
  }
  // Guard: an all-removed doc isn't a state the editor can produce
  // (the browser schema keeps >= 1 block). Re-insert one unminted
  // block if drained.
  if (after.length === 0) {
    after.push(genCanonicalBlock(rand, ""));
  }
  return after;
}

function equivalentModuloMintedIds(post: readonly Block[], after: readonly Block[]): void {
  expect(post).toHaveLength(after.length);
  for (let i = 0; i < after.length; i += 1) {
    const p = post[i];
    const a = after[i];
    if (p === undefined || a === undefined) throw new Error("length mismatch");
    expect(p.type).toBe(a.type);
    expect(p.props).toEqual(a.props);
    expect(p.content).toEqual(a.content);
    if (a.id.length > 0 && p.id === a.id) continue; // survived in place
    // re-minted (insert): must be a fresh non-empty id
    expect(p.id.length).toBeGreaterThan(0);
  }
}

describe("apply ∘ diff law", () => {
  it("reconstructs the after-state for 120 seeded before/after pairs", async () => {
    const rand = prng(0x0038);
    for (let round = 0; round < 120; round += 1) {
      const size = 1 + Math.floor(rand() * 6);
      const before: Block[] = [];
      for (let i = 0; i < size; i += 1) {
        before.push(
          genCanonicalBlock(
            rand,
            `018f0000-0000-7000-8000-${String(round * 100 + i).padStart(12, "0")}`,
          ),
        );
      }
      const after = mutate(rand, before);
      const ops = diffBlocksToOps(before, after);
      if (ops.length === 0) {
        expect(after).toEqual(before);
        continue;
      }
      // The browser sends diff output over the wire; the capability
      // parses it before the applier runs. Routing through the REAL
      // input schema both brands the ids and proves every diff output
      // validates against the wire contract.
      const parsed = DocUpdateInputSchema.parse({ doc_id: DOC, ops });
      const { post } = await applyOpsToBlocks(before, parsed.ops, { doc_id: DOC, mintId });
      equivalentModuloMintedIds(post, after);
    }
  });

  it("round-trips with hash preconditions attached (no spurious 409s on a clean base)", async () => {
    const rand = prng(0xbeef);
    for (let round = 0; round < 20; round += 1) {
      const before = [
        genCanonicalBlock(rand, B1),
        genCanonicalBlock(rand, B2),
        genCanonicalBlock(rand, B3),
      ];
      const hashes = new Map<string, string>();
      for (const b of before) hashes.set(b.id, await hashBlockContent(b));
      const after = mutate(rand, before);
      const ops = diffBlocksToOps(before, after, hashes);
      if (ops.length === 0) {
        expect(after).toEqual(before);
        continue;
      }
      const parsed = DocUpdateInputSchema.parse({ doc_id: DOC, ops });
      const { post } = await applyOpsToBlocks(before, parsed.ops, { doc_id: DOC, mintId });
      equivalentModuloMintedIds(post, after);
    }
  });
});
