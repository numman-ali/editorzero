// @vitest-environment happy-dom
/// <reference lib="dom" />

/**
 * `doc.rename` — capability-level integration test.
 *
 * Exercises the handler against real in-memory SQLite + a real
 * `MemorySyncService` so the dual-write (docs.title bridge + Y.Doc
 * title-block mutation) actually lands. DOM runs under happy-dom
 * because `setDocTitle` threads through `withLiveEditor` — the
 * collab-plugin `view.dispatch` path is DOM-backed.
 *
 * Dispatcher wiring (zod parse, audit row emit, write-path tx commit)
 * is the dispatcher's test. Cross-tenant scoping is separately owned
 * by `packages/db/src/tenant.unit.test.ts`; here we only confirm
 * `doc.rename` composes with that layer.
 */

import { createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { type CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
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
import { docRename } from "./rename";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2_DELETED = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d3");
const DOC_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");

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

interface OutboxCapture {
  readonly event: string;
  readonly payload: unknown;
}

function buildCtx(
  workspace_id: WorkspaceId,
  now: () => number = () => 1000,
): { readonly ctx: CapabilityContext; readonly outboxEmits: readonly OutboxCapture[] } {
  const outboxEmits: OutboxCapture[] = [];
  const ctx: CapabilityContext = {
    principal: userPrincipal(),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    transact: (doc_id, fn) => sync.transact(doc_id, fn),
    outbox: (event, payload) => {
      outboxEmits.push({ event, payload });
    },
    logger: noopLogger,
    tracer: noopTracer,
    now,
  };
  return { ctx, outboxEmits };
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
 * Seed the Y.Doc with the `doc.create` canonical shape: a heading-1 at
 * index 0 carrying `title` + a trailing empty paragraph. Matches
 * what a real doc would look like under the runtime.
 */
async function seedTitleBlock(doc_id: DocId, title: string): Promise<void> {
  await sync.transact(doc_id, (ydoc) => {
    seedBlocks(ydoc, [
      {
        type: "heading",
        props: { level: 1 },
        content: title,
      } as unknown as LoosePartialBlock,
      { type: "paragraph", content: "" } as LoosePartialBlock,
    ]);
  });
}

/**
 * Read the title text of block 0 via the pure `readBlocks` path —
 * doesn't need a live editor for the projection.
 */
async function readTitleBlock(doc_id: DocId): Promise<string | undefined> {
  return sync.transact(doc_id, (ydoc) => {
    const blocks = readBlocks(ydoc);
    const first = blocks[0];
    if (first === undefined || first.type !== "heading") return undefined;
    const parts = Array.isArray(first.content)
      ? (first.content as ReadonlyArray<{ text?: unknown }>)
      : [];
    return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.rename", () => {
  it("updates docs.title + slug + updated_at and rewrites the Y.Doc title block in place", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Old Title" });
    await seedTitleBlock(DOC_A1, "Old Title");

    const { ctx, outboxEmits } = buildCtx(WORKSPACE_A, () => 2_000_000);
    const out = await docRename.handler(ctx, { doc_id: DOC_A1, title: "New Title" });

    expect(out).toEqual({
      doc_id: DOC_A1,
      title: "New Title",
      slug: "new-title",
      updated_at: 2_000_000,
    });

    // Row-side bridge updated — doc.list / doc.get read docs.title
    // directly today, so this has to change in the same tx as the
    // CRDT mutation.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["title", "slug", "updated_at"])
      .where("id", "=", DOC_A1)
      .executeTakeFirstOrThrow();
    expect(row.title).toBe("New Title");
    expect(row.slug).toBe("new-title");
    expect(row.updated_at).toBe(2_000_000);

    // Block-side: the heading-1 title text reflects the rename. The
    // title-slot rule updated block 0 in place (no re-insertion) —
    // the MemorySyncService test doesn't exercise persistence but
    // the integration smoke (blocknote.integration.test.ts) covers
    // the live-editor path end-to-end.
    expect(await readTitleBlock(DOC_A1)).toBe("New Title");

    // No outbox emission from the handler itself — `ctx.transact`'s
    // bound writer emits `outbox(doc.updated)` under the real
    // HocuspocusSync path; the MemorySyncService stub here doesn't
    // replicate that seam, but the handler's own behaviour is "no
    // direct ctx.outbox calls", which this asserts.
    expect(outboxEmits).toEqual([]);
  });

  it("trims whitespace from the title before applying (leading/trailing only)", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Draft" });
    await seedTitleBlock(DOC_A1, "Draft");

    // The input schema's `.trim()` runs before the handler sees
    // `title`. A caller-supplied "  Hello World  " lands as
    // "Hello World" in both docs.title and the heading block.
    const trimmed = docRename.input.parse({ doc_id: DOC_A1, title: "  Hello World  " });
    expect(trimmed.title).toBe("Hello World");

    const { ctx } = buildCtx(WORKSPACE_A);
    const out = await docRename.handler(ctx, trimmed);
    expect(out.title).toBe("Hello World");
    expect(out.slug).toBe("hello-world");
    expect(await readTitleBlock(DOC_A1)).toBe("Hello World");
  });

  it("falls back to slug `untitled` when the title is all non-alphanumeric (emoji/punctuation)", async () => {
    // `slugify` produces an empty base for a title like "🎉!" →
    // `docs.slug` NOT NULL would trip without the fallback. The
    // handler's slug derivation guards with "untitled".
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Old" });
    await seedTitleBlock(DOC_A1, "Old");

    const { ctx } = buildCtx(WORKSPACE_A);
    const out = await docRename.handler(ctx, { doc_id: DOC_A1, title: "🎉!" });

    expect(out.title).toBe("🎉!");
    expect(out.slug).toBe("untitled");
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docRename.handler(ctx, { doc_id: DOC_MISSING, title: "Whatever" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("treats soft-deleted docs as not found (rename is a live-doc op, not resurrection)", async () => {
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Trashed",
      deleted_at: 999,
    });
    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docRename.handler(ctx, { doc_id: DOC_A2_DELETED, title: "Revived" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Row must remain untouched — a soft-deleted doc's title should
    // not be mutated through an error path.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["title", "updated_at"])
      .where("id", "=", DOC_A2_DELETED)
      .executeTakeFirstOrThrow();
    expect(row.title).toBe("Trashed");
    expect(row.updated_at).toBe(1);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot rename workspace-B doc", async () => {
    await seedDocRow({ id: DOC_B1, workspace_id: WORKSPACE_B, title: "B1" });
    const { ctx: ctxA } = buildCtx(WORKSPACE_A);

    // Same UUID, different workspace — the WorkspaceScopingPlugin
    // injects `workspace_id = A` on the UPDATE; the row (owned by B)
    // is invisible and the handler throws `NotFoundError` without
    // leaking cross-tenant existence.
    await expect(
      docRename.handler(ctxA, { doc_id: DOC_B1, title: "Cross-tenant attempt" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Workspace-B's row stays unmutated.
    const row = await driver
      .scoped(WORKSPACE_B)
      .selectFrom("docs")
      .select(["title"])
      .where("id", "=", DOC_B1)
      .executeTakeFirstOrThrow();
    expect(row.title).toBe("B1");
  });

  it("rejects a non-UUIDv7 doc_id at the input schema", () => {
    const result = docRename.input.safeParse({
      doc_id: "018f0000-0000-4000-a000-000000000001",
      title: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["doc_id"]);
    }
  });

  it("rejects an empty title at the input schema", () => {
    const result = docRename.input.safeParse({ doc_id: DOC_A1, title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only title at the input schema (trim + min(1))", () => {
    const result = docRename.input.safeParse({ doc_id: DOC_A1, title: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects unknown input keys (strict)", () => {
    const result = docRename.input.safeParse({
      doc_id: DOC_A1,
      title: "Hi",
      slug: "manual-slug",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("declares the correct registry metadata", () => {
    expect(docRename.id).toBe("doc.rename");
    expect(docRename.category).toBe("mutation");
    expect(docRename.requires).toEqual(["doc:write"]);
    expect(docRename.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(docRename.agentAllowed).toBeDefined();
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docRename.audit.subjectFrom({ doc_id: DOC_A1, title: "x" });
    expect(subject).toEqual({ kind: "doc", id: DOC_A1 });
  });

  it("emits doc.rename on allow with doc_id + title + slug", () => {
    const effect = docRename.audit.effectOnAllow(
      { doc_id: DOC_A1, title: "New Title" },
      { doc_id: DOC_A1, title: "New Title", slug: "new-title", updated_at: 2_000_000 },
    );
    expect(effect.kind).toBe("doc.rename");
    if (effect.kind === "doc.rename") {
      expect(effect.doc_id).toBe(DOC_A1);
      expect(effect.title).toBe("New Title");
      // The handler-derived slug rides the effect so replay reconstructs it
      // (the projection reads it; carrying only title would strand the slug).
      expect(effect.slug).toBe("new-title");
    }
  });

  it("emits a deny effect carrying the reason code", () => {
    const effect = docRename.audit.effectOnDeny(
      { doc_id: DOC_A1, title: "x" },
      { kind: "missing_scope", required: ["doc:write"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.rename");
      expect(effect.required_scopes).toEqual(["doc:write"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    const effect = docRename.audit.effectOnError(
      { doc_id: DOC_A1, title: "x" },
      { kind: "not_found", subject_kind: "doc", subject_id: DOC_A1 },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.rename");
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("is not collapsible (mutations never collapse — F2)", () => {
    expect(docRename.audit.collapsePolicy.collapsible).toBe(false);
  });
});
