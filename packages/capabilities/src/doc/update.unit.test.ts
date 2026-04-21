// @vitest-environment happy-dom
/// <reference lib="dom" />

/**
 * `doc.update` — capability-level integration test.
 *
 * Same fixture shape as `doc.rename`: in-memory SQLite + a real
 * `MemorySyncService` so `ctx.transact` + `withLiveEditor` flow through
 * the full editor-mount lifecycle. DOM runs under happy-dom because
 * `withLiveEditor` needs `document.createElement` for the
 * y-prosemirror collab plugin's `view.dispatch` path.
 *
 * Coverage split: dispatcher wiring (parse → gate → audit row) is the
 * dispatcher's test; cross-tenant scoping is owned by
 * `packages/db/src/tenant.unit.test.ts`; here we only confirm
 * `doc.update` composes with those layers.
 */

import { createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError, StalePreconditionError } from "@editorzero/errors";
import {
  BlockId,
  type CollectionId,
  DocId,
  generateBlockId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import {
  type LoosePartialBlock,
  MemorySyncService,
  readBlocks,
  seedBlocks,
} from "@editorzero/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { __internal, docUpdate } from "./update";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2_DELETED = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d3");
const DOC_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");

const BLOCK_TITLE = BlockId("018f0000-0000-7000-8000-00000000b001");
const BLOCK_BODY = BlockId("018f0000-0000-7000-8000-00000000b002");
const BLOCK_TAIL = BlockId("018f0000-0000-7000-8000-00000000b003");
const BLOCK_MISSING = BlockId("018f0000-0000-7000-8000-00000000bfff");

let driver: SqliteDriver;
let sync: MemorySyncService;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(DOCS_DDL);
  sync = new MemorySyncService();
});

afterEach(async () => {
  await sync.close();
  await driver.close();
});

function userPrincipal(): UserPrincipal {
  return {
    kind: "user",
    id: ALICE,
    workspace_id: WORKSPACE_A,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function buildCtx(
  workspace_id: WorkspaceId,
  now: () => number = () => 1_000,
): { readonly ctx: CapabilityContext } {
  const ctx: CapabilityContext = {
    principal: userPrincipal(),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    transact: (doc_id, fn) => sync.transact(doc_id, fn),
    outbox: () => {
      // no-op — doc.update never calls ctx.outbox (content mutations
      // emit doc.updated via the ctx.transact-bound writer, not the
      // handler). If this ever fires, something went wrong.
    },
    logger: noopLogger,
    tracer: noopTracer,
    now,
  };
  return { ctx };
}

async function seedDocRow(params: {
  id: DocId;
  workspace_id: WorkspaceId;
  title: string;
  collection_id?: CollectionId | null;
  deleted_at?: number | null;
}) {
  const scoped = driver.scoped(params.workspace_id);
  await scoped
    .insertInto("docs")
    .values({
      id: params.id,
      workspace_id: params.workspace_id,
      collection_id: params.collection_id ?? null,
      title: params.title,
      slug: params.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      order_key: params.id,
      visibility: "workspace",
      visibility_version: 0,
      created_by: ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at: params.deleted_at ?? null,
    })
    .execute();
}

/**
 * Seed three canonical blocks: a title heading-1, a body paragraph, and
 * a trailing empty paragraph. Matches what `doc.create` would seed in
 * production — the trailing paragraph is BlockNote's normalisation
 * tail, which `withLiveEditor` would otherwise auto-mint on mount
 * (adding an extra block with a BlockNote-minted id to every test).
 * Providing one with a known id keeps every assertion on the block
 * list stable.
 */
async function seedBasicDoc(doc_id: DocId, titleText: string): Promise<void> {
  await sync.transact(doc_id, (ydoc) => {
    seedBlocks(ydoc, [
      {
        id: BLOCK_TITLE,
        type: "heading",
        props: { level: 1 },
        content: titleText,
      } as unknown as LoosePartialBlock,
      {
        id: BLOCK_BODY,
        type: "paragraph",
        content: "Body text",
      } as unknown as LoosePartialBlock,
      {
        id: BLOCK_TAIL,
        type: "paragraph",
        content: "",
      } as unknown as LoosePartialBlock,
    ]);
  });
}

/** Project the title block's inline text, for before/after assertions. */
async function readBlockText(doc_id: DocId, blockId: BlockId): Promise<string | undefined> {
  return sync.transact(doc_id, (ydoc) => {
    const blocks = readBlocks(ydoc);
    const block = blocks.find((b) => b.id === blockId);
    if (block === undefined) return undefined;
    const parts = Array.isArray(block.content)
      ? (block.content as ReadonlyArray<{ text?: unknown }>)
      : [];
    return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  });
}

async function readBlockIds(doc_id: DocId): Promise<string[]> {
  return sync.transact(doc_id, (ydoc) => readBlocks(ydoc).map((b) => b.id));
}

/**
 * Compute the canonical-JSON sha256 over `{type, props, content}` for a
 * block read through `readBlocks`. Mirror of the handler's
 * `hashBlockContent` — tests use this to construct hash-match scenarios
 * without reaching into the handler's internals.
 */
async function hashOf(doc_id: DocId, blockId: BlockId): Promise<string> {
  return sync.transact(doc_id, (ydoc) => {
    const block = readBlocks(ydoc).find((b) => b.id === blockId);
    if (block === undefined) throw new Error(`block ${blockId} not found`);
    return __internal.hashBlockContent(block);
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.update", () => {
  it("inserts a new block after an existing one and returns the minted id in applied_ops", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");

    const { ctx } = buildCtx(WORKSPACE_A, () => 2_000);
    const out = await docUpdate.handler(ctx, {
      doc_id: DOC_A1,
      ops: [
        {
          op: "insert",
          block: { type: "paragraph", content: "Inserted" },
          after_block_id: BLOCK_BODY,
        },
      ],
    });

    expect(out.doc_id).toBe(DOC_A1);
    expect(out.updated_at).toBe(2_000);
    expect(out.applied_ops).toHaveLength(1);

    const first = out.applied_ops[0];
    expect(first?.op).toBe("insert");
    if (first?.op === "insert") {
      // Block id was minted by the handler — should be a BlockId-shaped
      // UUIDv7 and round-trip on the applied op.
      expect(first.block.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/);
      expect(first.block.type).toBe("paragraph");
      expect(first.after_block_id).toBe(BLOCK_BODY);
    }

    // Fragment-side: four blocks now, new one inserted after body,
    // trailing empty paragraph preserved after.
    const ids = await readBlockIds(DOC_A1);
    expect(ids).toHaveLength(4);
    expect(ids[0]).toBe(BLOCK_TITLE);
    expect(ids[1]).toBe(BLOCK_BODY);
    expect(ids[2]).toBe(first?.op === "insert" ? first.block.id : "never");
    expect(ids[3]).toBe(BLOCK_TAIL);

    // Row-side bridge: `updated_at` bumped in the same tx.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["updated_at"])
      .where("id", "=", DOC_A1)
      .executeTakeFirstOrThrow();
    expect(row.updated_at).toBe(2_000);
  });

  it("inserts at the top when after_block_id is null (placement `before` against block 0)", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");

    const { ctx } = buildCtx(WORKSPACE_A);
    const out = await docUpdate.handler(ctx, {
      doc_id: DOC_A1,
      ops: [
        {
          op: "insert",
          block: { type: "paragraph", content: "Prepended" },
          after_block_id: null,
        },
      ],
    });

    const ids = await readBlockIds(DOC_A1);
    const first = out.applied_ops[0];
    if (first?.op === "insert") {
      expect(ids[0]).toBe(first.block.id);
      expect(ids[1]).toBe(BLOCK_TITLE);
      expect(ids[2]).toBe(BLOCK_BODY);
      expect(ids[3]).toBe(BLOCK_TAIL);
    }
  });

  it("updates a block's content in place (preserves id, applies patch)", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");

    const { ctx } = buildCtx(WORKSPACE_A);
    await docUpdate.handler(ctx, {
      doc_id: DOC_A1,
      ops: [
        {
          op: "update",
          block_id: BLOCK_BODY,
          patch: { content: "Rewritten body" },
        },
      ],
    });

    expect(await readBlockText(DOC_A1, BLOCK_BODY)).toBe("Rewritten body");
    // Block id preserved.
    const ids = await readBlockIds(DOC_A1);
    expect(ids).toContain(BLOCK_BODY);
  });

  it("update op with matching expect_prior_content_hash succeeds", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");

    const currentHash = await hashOf(DOC_A1, BLOCK_BODY);
    const { ctx } = buildCtx(WORKSPACE_A);
    await docUpdate.handler(ctx, {
      doc_id: DOC_A1,
      ops: [
        {
          op: "update",
          block_id: BLOCK_BODY,
          patch: { content: "Preconditioned edit" },
          expect_prior_content_hash: currentHash,
        },
      ],
    });

    expect(await readBlockText(DOC_A1, BLOCK_BODY)).toBe("Preconditioned edit");
  });

  it("update op with mismatched expect_prior_content_hash throws StalePreconditionError", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");

    const staleHash = "0".repeat(64); // valid shape, wrong value
    const { ctx } = buildCtx(WORKSPACE_A);

    await expect(
      docUpdate.handler(ctx, {
        doc_id: DOC_A1,
        ops: [
          {
            op: "update",
            block_id: BLOCK_BODY,
            patch: { content: "Shouldn't land" },
            expect_prior_content_hash: staleHash,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(StalePreconditionError);

    // Content must remain unchanged — the transact closure threw before
    // applying. (The dispatcher-side tx rollback is the dispatcher's
    // test; here MemorySyncService doesn't rollback on throw, so the
    // assertion is strict on "mutation didn't reach the editor", which
    // it didn't — `updateBlock` is called inside the throw's scope.)
    expect(await readBlockText(DOC_A1, BLOCK_BODY)).toBe("Body text");
  });

  it("remove op deletes the block and returns its preimage", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");

    const { ctx } = buildCtx(WORKSPACE_A);
    const out = await docUpdate.handler(ctx, {
      doc_id: DOC_A1,
      ops: [
        {
          op: "remove",
          block_id: BLOCK_BODY,
        },
      ],
    });

    const op = out.applied_ops[0];
    expect(op?.op).toBe("remove");
    if (op?.op === "remove") {
      expect(op.block_id).toBe(BLOCK_BODY);
      expect(op.preimage.id).toBe(BLOCK_BODY);
      expect(op.preimage.type).toBe("paragraph");
    }

    const ids = await readBlockIds(DOC_A1);
    expect(ids).not.toContain(BLOCK_BODY);
  });

  it("remove op with mismatched expect_prior_content_hash throws", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");

    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docUpdate.handler(ctx, {
        doc_id: DOC_A1,
        ops: [
          {
            op: "remove",
            block_id: BLOCK_BODY,
            expect_prior_content_hash: "f".repeat(64),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(StalePreconditionError);
  });

  it("applies a multi-op batch (insert + update + remove) atomically under one editor.transact", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");

    const { ctx } = buildCtx(WORKSPACE_A);
    const out = await docUpdate.handler(ctx, {
      doc_id: DOC_A1,
      ops: [
        {
          op: "insert",
          block: { type: "paragraph", content: "Added" },
          after_block_id: BLOCK_TITLE,
        },
        {
          op: "update",
          block_id: BLOCK_TITLE,
          patch: { content: "New Title" },
        },
        {
          op: "remove",
          block_id: BLOCK_BODY,
        },
      ],
    });

    expect(out.applied_ops).toHaveLength(3);
    expect(out.applied_ops[0]?.op).toBe("insert");
    expect(out.applied_ops[1]?.op).toBe("update");
    expect(out.applied_ops[2]?.op).toBe("remove");

    // Fragment-side: original BODY gone, original TITLE still there but
    // updated, new block inserted between them, tail preserved.
    const ids = await readBlockIds(DOC_A1);
    expect(ids).toContain(BLOCK_TITLE);
    expect(ids).not.toContain(BLOCK_BODY);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(BLOCK_TITLE);
    expect(ids[2]).toBe(BLOCK_TAIL);
    expect(await readBlockText(DOC_A1, BLOCK_TITLE)).toBe("New Title");
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docUpdate.handler(ctx, {
        doc_id: DOC_MISSING,
        ops: [{ op: "update", block_id: BLOCK_BODY, patch: { content: "x" } }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("treats soft-deleted docs as not found (update is a live-doc op)", async () => {
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Trashed",
      deleted_at: 999,
    });
    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docUpdate.handler(ctx, {
        doc_id: DOC_A2_DELETED,
        ops: [{ op: "update", block_id: BLOCK_BODY, patch: { content: "x" } }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError with subject_kind=block when update targets a missing block_id", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");
    const { ctx } = buildCtx(WORKSPACE_A);
    try {
      await docUpdate.handler(ctx, {
        doc_id: DOC_A1,
        ops: [{ op: "update", block_id: BLOCK_MISSING, patch: { content: "x" } }],
      });
      expect.fail("expected NotFoundError");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      if (err instanceof NotFoundError) {
        expect(err.subject_kind).toBe("block");
        expect(err.subject_id).toBe(BLOCK_MISSING);
      }
    }
  });

  it("throws NotFoundError when insert's after_block_id points at a missing block", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");
    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docUpdate.handler(ctx, {
        doc_id: DOC_A1,
        ops: [
          {
            op: "insert",
            block: { type: "paragraph", content: "orphan" },
            after_block_id: BLOCK_MISSING,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when remove targets a missing block_id", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1, "Doc");
    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docUpdate.handler(ctx, {
        doc_id: DOC_A1,
        ops: [{ op: "remove", block_id: BLOCK_MISSING }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot update workspace-B doc", async () => {
    await seedDocRow({ id: DOC_B1, workspace_id: WORKSPACE_B, title: "B1" });
    const { ctx: ctxA } = buildCtx(WORKSPACE_A);
    await expect(
      docUpdate.handler(ctxA, {
        doc_id: DOC_B1,
        ops: [{ op: "update", block_id: BLOCK_BODY, patch: { content: "x" } }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── Input validation ────────────────────────────────────────────────────

  it("rejects a non-UUIDv7 doc_id at the input schema", () => {
    const result = docUpdate.input.safeParse({
      doc_id: "018f0000-0000-4000-a000-000000000001", // v4
      ops: [{ op: "update", block_id: BLOCK_BODY, patch: { content: "x" } }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUIDv7 block_id at the input schema", () => {
    const result = docUpdate.input.safeParse({
      doc_id: DOC_A1,
      ops: [
        { op: "update", block_id: "018f0000-0000-4000-a000-000000000001", patch: { content: "x" } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty ops array", () => {
    const result = docUpdate.input.safeParse({ doc_id: DOC_A1, ops: [] });
    expect(result.success).toBe(false);
  });

  it("rejects an op with an unknown `op` literal (e.g. 'move')", () => {
    const result = docUpdate.input.safeParse({
      doc_id: DOC_A1,
      ops: [{ op: "move", block_id: BLOCK_BODY, new_parent_block_id: null, new_order_key: "a0" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // discriminated-union error surfaces the `op` field as the
      // discriminator issue — we don't match exact text, just verify
      // the path pinpoints the op.
      expect(result.error.issues.some((i) => i.path.includes("op"))).toBe(true);
    }
  });

  it("rejects an expect_prior_content_hash that isn't 64 lowercase hex chars", () => {
    const tooShort = docUpdate.input.safeParse({
      doc_id: DOC_A1,
      ops: [
        {
          op: "update",
          block_id: BLOCK_BODY,
          patch: { content: "x" },
          expect_prior_content_hash: "abc123",
        },
      ],
    });
    expect(tooShort.success).toBe(false);

    const uppercase = docUpdate.input.safeParse({
      doc_id: DOC_A1,
      ops: [
        {
          op: "update",
          block_id: BLOCK_BODY,
          patch: { content: "x" },
          expect_prior_content_hash: "F".repeat(64),
        },
      ],
    });
    expect(uppercase.success).toBe(false);
  });

  it("rejects unknown keys on an op (strict)", () => {
    const result = docUpdate.input.safeParse({
      doc_id: DOC_A1,
      ops: [
        {
          op: "update",
          block_id: BLOCK_BODY,
          patch: { content: "x" },
          extra_field: "should not pass",
          // biome-ignore lint/suspicious/noExplicitAny: invalid-input probe; zod is the validator.
        } as any,
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys on the insert op's `block` sub-object (strict)", () => {
    const result = docUpdate.input.safeParse({
      doc_id: DOC_A1,
      ops: [
        {
          op: "insert",
          block: {
            type: "paragraph",
            content: "x",
            id: generateBlockId(),
            // biome-ignore lint/suspicious/noExplicitAny: invalid-input probe; zod is the validator.
          } as any,
          after_block_id: null,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  // ── Registry / audit metadata ───────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(docUpdate.id).toBe("doc.update");
    expect(docUpdate.category).toBe("mutation");
    expect(docUpdate.requires).toEqual(["doc:write", "block:write"]);
    expect(docUpdate.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(docUpdate.agentAllowed).toBeDefined();
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docUpdate.audit.subjectFrom({
      doc_id: DOC_A1,
      ops: [{ op: "remove", block_id: BLOCK_BODY }],
    });
    expect(subject).toEqual({ kind: "doc", id: DOC_A1 });
  });

  it("emits doc.update_batch on allow projecting each op kind 1:1", () => {
    const titlePost = {
      id: BLOCK_TITLE,
      doc_id: DOC_A1,
      type: "heading",
      parent_block_id: null,
      order_key: "000000",
      content_json: { props: { level: 1 }, content: "Title" },
      visibility: "default" as const,
    };
    const bodyPost = {
      id: BLOCK_BODY,
      doc_id: DOC_A1,
      type: "paragraph",
      parent_block_id: null,
      order_key: "000001",
      content_json: { content: "New body" },
      visibility: "default" as const,
    };
    const insertedPost = {
      id: BLOCK_TAIL,
      doc_id: DOC_A1,
      type: "paragraph",
      parent_block_id: null,
      order_key: "000002",
      content_json: { content: "Appended" },
      visibility: "default" as const,
    };
    const effect = docUpdate.audit.effectOnAllow(
      {
        doc_id: DOC_A1,
        ops: [
          {
            op: "insert",
            block: { type: "paragraph", content: "Appended" },
            after_block_id: BLOCK_TITLE,
          },
          { op: "update", block_id: BLOCK_BODY, patch: { content: "x" } },
          { op: "remove", block_id: BLOCK_TITLE },
        ],
      },
      {
        doc_id: DOC_A1,
        updated_at: 2_000,
        applied_ops: [
          {
            op: "insert",
            block: insertedPost,
            after_block_id: BLOCK_TITLE,
            parent_block_id: null,
          },
          { op: "update", block_id: BLOCK_BODY, post: bodyPost },
          { op: "remove", block_id: BLOCK_TITLE, preimage: titlePost },
        ],
      },
    );
    expect(effect.kind).toBe("doc.update_batch");
    if (effect.kind === "doc.update_batch") {
      expect(effect.doc_id).toBe(DOC_A1);
      expect(effect.ops).toEqual([
        { op: "insert", block: insertedPost, after_block_id: BLOCK_TITLE, parent_block_id: null },
        { op: "update", block_id: BLOCK_BODY, post: bodyPost },
        { op: "remove", block_id: BLOCK_TITLE, preimage: titlePost },
      ]);
    }
  });

  it("emits a deny effect carrying missing_scope when the principal lacks doc:write / block:write", () => {
    const effect = docUpdate.audit.effectOnDeny(
      { doc_id: DOC_A1, ops: [] },
      { kind: "missing_scope", required: ["doc:write", "block:write"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.update");
      expect(effect.required_scopes).toEqual(["doc:write", "block:write"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("projects a conflict handler error (from StalePreconditionError) through projectErrorAudit", () => {
    const effect = docUpdate.audit.effectOnError({ doc_id: DOC_A1, ops: [] }, { kind: "conflict" });
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.update");
      expect(effect.error_code).toBe("conflict");
      // Conflicts are client-retriable.
      expect(effect.retriable).toBe(true);
    }
  });

  it("is not collapsible (mutations never collapse — F2)", () => {
    expect(docUpdate.audit.collapsePolicy.collapsible).toBe(false);
  });

  // ── Hash helper — direct assertion on canonical JSON shape ──────────────

  it("hashBlockContent produces the same digest regardless of key order in props", () => {
    const a = __internal.hashBlockContent({
      type: "paragraph",
      props: { a: 1, b: 2 },
      content: "x",
    });
    const b = __internal.hashBlockContent({
      type: "paragraph",
      props: { b: 2, a: 1 },
      content: "x",
    });
    expect(a).toBe(b);
  });

  it("hashBlockContent differs when content changes", () => {
    const a = __internal.hashBlockContent({ type: "paragraph", content: "x" });
    const b = __internal.hashBlockContent({ type: "paragraph", content: "y" });
    expect(a).not.toBe(b);
  });
});
