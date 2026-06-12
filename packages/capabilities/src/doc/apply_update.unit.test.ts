/**
 * `doc.apply_update` — capability-level integration test.
 *
 * Same fixture shape as `doc.update`: in-memory SQLite + a real
 * `MemorySyncService` so `ctx.transact` flows through the owned
 * foreign-update lane (`applyForeignUpdate`, ADR 0043 Decision 2).
 *
 * The lane's own refusal matrix is exhaustively pinned in
 * `packages/sync/src/foreign-update.unit.test.ts`; here we confirm the
 * capability composes it — ceiling + 404 ordering, the
 * `ForeignUpdateRefusedError → ValidationError` mapping with structured
 * issues, the no-op marker, branded minted ids on the output, the
 * `updated_at` bridge (bumps even on the no-op), and the audit
 * projections (effect carries the output's blob, never the input).
 *
 * Deltas are built the way a real client builds them: fork a twin from
 * the doc's current state, mutate the twin, encode against the
 * pre-mutation state vector, base64 it.
 */

import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  DOCS_DDL,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { NotFoundError, ValidationError } from "@editorzero/errors";
import { BlockId, type CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import {
  base64ToBytes,
  bytesToBase64,
  DOC_FRAGMENT,
  MemorySyncService,
  readBlocks,
  type SeedBlock,
  seedBlocks,
  writeBlocks,
} from "@editorzero/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { CapabilityContext } from "../kernel";
import { docApplyUpdate } from "./apply_update";

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

let driver: SqliteDriver;
let sync: MemorySyncService;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
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
      // no-op — doc.apply_update never calls ctx.outbox (content
      // mutations emit doc.updated via the ctx.transact-bound writer).
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
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
      created_by: ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at: params.deleted_at ?? null,
    })
    .execute();
}

async function seedBasicDoc(doc_id: DocId): Promise<void> {
  const seeds: SeedBlock[] = [
    { id: BLOCK_TITLE, type: "heading", props: { level: 1 }, content: "Title" },
    { id: BLOCK_BODY, type: "paragraph", content: "Body" },
  ];
  await sync.transact(doc_id, (ydoc) => {
    seedBlocks(ydoc, seeds);
  });
}

/** Snapshot the doc's full CRDT state (read-only transact). */
async function stateOf(doc_id: DocId): Promise<Uint8Array> {
  return sync.transact(doc_id, (ydoc) => Y.encodeStateAsUpdate(ydoc));
}

function forkFrom(state: Uint8Array): Y.Doc {
  const twin = new Y.Doc();
  Y.applyUpdate(twin, state);
  return twin;
}

/** Base64 delta: the twin's changes since `sv` — what a provider sends. */
function deltaB64(twin: Y.Doc, sv: Uint8Array): string {
  return bytesToBase64(Y.encodeStateAsUpdate(twin, sv));
}

async function blockTexts(doc_id: DocId): Promise<string[]> {
  return sync.transact(doc_id, (ydoc) =>
    readBlocks(ydoc).map((b) =>
      b.content.map((run) => (typeof run.text === "string" ? run.text : "")).join(""),
    ),
  );
}

async function validationErrorOf(promise: Promise<unknown>): Promise<ValidationError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ValidationError) return err;
    throw err;
  }
  throw new Error("expected ValidationError");
}

function firstIssueReason(err: ValidationError): unknown {
  const issues = err.issues;
  if (!Array.isArray(issues)) throw new Error("expected issues array");
  const first = issues[0];
  if (typeof first !== "object" || first === null) throw new Error("expected issue object");
  return (first as Record<string, unknown>)["reason"];
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.apply_update", () => {
  it("applies a novel delta, returns the exact persisted blob, and bumps updated_at", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1);

    const before = await stateOf(DOC_A1);
    const editor = forkFrom(before);
    const sv = Y.encodeStateVector(editor);
    writeBlocks(
      editor,
      readBlocks(editor).map((b) =>
        b.id === BLOCK_BODY
          ? { ...b, content: [{ type: "text" as const, text: "Edited body", styles: {} }] }
          : b,
      ),
    );

    const { ctx } = buildCtx(WORKSPACE_A, () => 2_000);
    const out = await docApplyUpdate.handler(ctx, {
      doc_id: DOC_A1,
      update: deltaB64(editor, sv),
    });

    expect(out.doc_id).toBe(DOC_A1);
    expect(out.applied).toBe(true);
    expect(out.minted_block_ids).toEqual([]);
    expect(out.updated_at).toBe(2_000);
    expect(await blockTexts(DOC_A1)).toEqual(["Title", "Edited body"]);

    // MUST-FIX 2 at the capability seam: the output blob alone replays
    // to the doc's final state on a pristine twin.
    expect(out.update_b64).not.toBeNull();
    if (out.update_b64 !== null) {
      const replay = forkFrom(before);
      Y.applyUpdate(replay, base64ToBytes(out.update_b64));
      const after = await stateOf(DOC_A1);
      expect(Array.from(Y.encodeStateVector(replay))).toEqual(
        Array.from(Y.encodeStateVector(forkFrom(after))),
      );
    }

    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["updated_at"])
      .where("id", "=", DOC_A1)
      .executeTakeFirstOrThrow();
    expect(row.updated_at).toBe(2_000);
  });

  it("returns the marked no-op for a contained delta — and still bumps updated_at (accepted residual)", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1);

    const contained = bytesToBase64(await stateOf(DOC_A1));
    const { ctx } = buildCtx(WORKSPACE_A, () => 3_000);
    const out = await docApplyUpdate.handler(ctx, { doc_id: DOC_A1, update: contained });

    expect(out.applied).toBe(false);
    expect(out.update_b64).toBeNull();
    expect(out.minted_block_ids).toEqual([]);
    expect(out.updated_at).toBe(3_000);
    expect(await blockTexts(DOC_A1)).toEqual(["Title", "Body"]);

    // The UPDATE-first 404 probe IS the bump — lands even on the no-op.
    const row = await driver
      .scoped(WORKSPACE_A)
      .selectFrom("docs")
      .select(["updated_at"])
      .where("id", "=", DOC_A1)
      .executeTakeFirstOrThrow();
    expect(row.updated_at).toBe(3_000);
  });

  it("repairs id-less blocks: branded minted ids on the output, repair folded into the blob", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1);

    const before = await stateOf(DOC_A1);
    const editor = forkFrom(before);
    const sv = Y.encodeStateVector(editor);
    const el = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "fresh insert");
    el.insert(0, [text]);
    editor.getXmlFragment(DOC_FRAGMENT).insert(2, [el]);

    const { ctx } = buildCtx(WORKSPACE_A);
    const out = await docApplyUpdate.handler(ctx, {
      doc_id: DOC_A1,
      update: deltaB64(editor, sv),
    });

    expect(out.applied).toBe(true);
    expect(out.minted_block_ids).toHaveLength(1);
    const minted = out.minted_block_ids[0];
    // Server-minted BlockId — UUIDv7-shaped, addressable by doc.update.
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/);

    const ids = await sync.transact(DOC_A1, (ydoc) => readBlocks(ydoc).map((b) => b.id));
    expect(ids).toEqual([BLOCK_TITLE, BLOCK_BODY, minted]);

    // The returned blob carries apply + mint as one unit.
    expect(out.update_b64).not.toBeNull();
    if (out.update_b64 !== null) {
      const replay = forkFrom(before);
      Y.applyUpdate(replay, base64ToBytes(out.update_b64));
      expect(readBlocks(replay).map((b) => b.id)).toEqual([BLOCK_TITLE, BLOCK_BODY, minted]);
    }
  });

  it("maps a foreign-shared-type refusal to ValidationError with structured issues", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1);

    const editor = forkFrom(await stateOf(DOC_A1));
    const sv = Y.encodeStateVector(editor);
    editor.getMap("evil").set("payload", "smuggled");

    const { ctx } = buildCtx(WORKSPACE_A);
    const err = await validationErrorOf(
      docApplyUpdate.handler(ctx, { doc_id: DOC_A1, update: deltaB64(editor, sv) }),
    );
    expect(err.code).toBe("validation_failed");
    expect(err.httpStatus).toBe(400);
    expect(firstIssueReason(err)).toBe("foreign_shared_type");
  });

  it("maps garbage bytes (valid base64, junk payload) to ValidationError not_integrable", async () => {
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Doc" });
    await seedBasicDoc(DOC_A1);

    const { ctx } = buildCtx(WORKSPACE_A);
    const err = await validationErrorOf(
      docApplyUpdate.handler(ctx, {
        doc_id: DOC_A1,
        update: bytesToBase64(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
      }),
    );
    expect(firstIssueReason(err)).toBe("not_integrable");
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docApplyUpdate.handler(ctx, { doc_id: DOC_MISSING, update: "AAAA" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("treats soft-deleted docs as not found", async () => {
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Trashed",
      deleted_at: 999,
    });
    const { ctx } = buildCtx(WORKSPACE_A);
    await expect(
      docApplyUpdate.handler(ctx, { doc_id: DOC_A2_DELETED, update: "AAAA" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot push into workspace-B doc", async () => {
    await seedDocRow({ id: DOC_B1, workspace_id: WORKSPACE_B, title: "B1" });
    const { ctx: ctxA } = buildCtx(WORKSPACE_A);
    await expect(
      docApplyUpdate.handler(ctxA, { doc_id: DOC_B1, update: "AAAA" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── Input validation ────────────────────────────────────────────────────

  it("rejects a non-UUIDv7 doc_id at the input schema", () => {
    const result = docApplyUpdate.input.safeParse({
      doc_id: "018f0000-0000-4000-a000-000000000001", // v4
      update: "AAAA",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty update string", () => {
    const result = docApplyUpdate.input.safeParse({ doc_id: DOC_A1, update: "" });
    expect(result.success).toBe(false);
  });

  it("rejects non-base64 alphabets (URL-safe, whitespace, raw bytes)", () => {
    for (const update of ["AA_-", "AAA AAA=", "näo", "AA\nAA"]) {
      const result = docApplyUpdate.input.safeParse({ doc_id: DOC_A1, update });
      expect(result.success).toBe(false);
    }
  });

  it("rejects unpadded base64 (length not divisible by 4)", () => {
    const result = docApplyUpdate.input.safeParse({ doc_id: DOC_A1, update: "AAAAA" });
    expect(result.success).toBe(false);
  });

  it("accepts padded base64 ('AA==', 'AAA=', 'AAAA')", () => {
    for (const update of ["AA==", "AAA=", "AAAA"]) {
      const result = docApplyUpdate.input.safeParse({ doc_id: DOC_A1, update });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an update over the size cap", () => {
    // One full quad over the cap keeps the probe shape-valid (% 4 === 0)
    // so the failure is attributable to `.max()` alone.
    const oversized = "A".repeat(13_981_016 + 4);
    const result = docApplyUpdate.input.safeParse({ doc_id: DOC_A1, update: oversized });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const result = docApplyUpdate.input.safeParse({
      doc_id: DOC_A1,
      update: "AAAA",
      origin: "ws",
    });
    expect(result.success).toBe(false);
  });

  // ── Registry / audit metadata ───────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(docApplyUpdate.id).toBe("doc.apply_update");
    expect(docApplyUpdate.category).toBe("mutation");
    expect(docApplyUpdate.requires).toEqual(["doc:write", "block:write"]);
    // ui = the live collab editor (the SPA provider slice, ADR 0043).
    expect(docApplyUpdate.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(docApplyUpdate.agentAllowed).toBeDefined();
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docApplyUpdate.audit.subjectFrom({ doc_id: DOC_A1, update: "AAAA" });
    expect(subject).toEqual({ kind: "doc", id: DOC_A1 });
  });

  it("emits doc.apply_update on allow, projecting the OUTPUT blob — never the caller input", () => {
    const effect = docApplyUpdate.audit.effectOnAllow(
      { doc_id: DOC_A1, update: "Q0FMTEVSLUlOUFVU" },
      {
        doc_id: DOC_A1,
        applied: true,
        update_b64: "UE9TVC1SRVBBSVI=",
        minted_block_ids: [BLOCK_BODY],
        updated_at: 2_000,
      },
    );
    expect(effect.kind).toBe("doc.apply_update");
    if (effect.kind === "doc.apply_update") {
      expect(effect.doc_id).toBe(DOC_A1);
      expect(effect.update_b64).toBe("UE9TVC1SRVBBSVI=");
      expect(effect.minted_block_ids).toEqual([BLOCK_BODY]);
    }
  });

  it("emits the marked no-op effect (update_b64 null) for a contained dispatch", () => {
    const effect = docApplyUpdate.audit.effectOnAllow(
      { doc_id: DOC_A1, update: "AAAA" },
      { doc_id: DOC_A1, applied: false, update_b64: null, minted_block_ids: [], updated_at: 1 },
    );
    if (effect.kind === "doc.apply_update") {
      expect(effect.update_b64).toBeNull();
      expect(effect.minted_block_ids).toEqual([]);
    } else {
      expect.fail("expected doc.apply_update effect");
    }
  });

  it("emits a deny effect carrying missing_scope for doc:write / block:write", () => {
    const effect = docApplyUpdate.audit.effectOnDeny(
      { doc_id: DOC_A1, update: "AAAA" },
      { kind: "missing_scope", required: ["doc:write", "block:write"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.apply_update");
      expect(effect.required_scopes).toEqual(["doc:write", "block:write"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("projects a validation handler error (refused delta) through projectErrorAudit", () => {
    const effect = docApplyUpdate.audit.effectOnError(
      { doc_id: DOC_A1, update: "AAAA" },
      { kind: "validation", issues: [{ reason: "foreign_shared_type" }] },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.apply_update");
      expect(effect.error_code).toBe("validation");
      // Caller must change the payload — refused deltas don't clear on retry.
      expect(effect.retriable).toBe(false);
    }
  });

  it("is not collapsible (mutations never collapse — F2)", () => {
    expect(docApplyUpdate.audit.collapsePolicy.collapsible).toBe(false);
  });
});
