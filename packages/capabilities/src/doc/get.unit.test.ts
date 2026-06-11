/**
 * `doc.get` — capability-level integration test.
 *
 * Exercises the handler against real in-memory SQLite + a real
 * `MemorySyncService`. Layer-2 tenant isolation is owned by
 * `packages/db/src/tenant.unit.test.ts`; here we confirm the
 * capability composes with that layer (workspace-A ctx cannot see
 * workspace-B docs) and that `ctx.transact` projects the seeded
 * blocks back through `readBlocks`.
 *
 * Dispatcher wiring (zod parse, audit row emit, gate) is the
 * dispatcher's test.
 */

import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { InternalError, NotFoundError } from "@editorzero/errors";
import { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { type LoosePartialBlock, MemorySyncService, seedBlocks } from "@editorzero/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docGet } from "./get";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const COLLECTION_C1 = CollectionId("018f0000-0000-7000-8000-0000000000c1");
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
  await driver.close();
  await sync.close();
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

function buildCtx(workspace_id: WorkspaceId): CapabilityContext {
  return {
    principal: userPrincipal(),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    // Kernel `TEditor` defaults to `unknown`; `MemorySyncService.transact`
    // hands the fn a real `Y.Doc`. A Y.Doc is assignable to `unknown`,
    // so bridging is a structural call-through — no cast at the
    // boundary, just a generic lambda that preserves `T`.
    transact: <T>(doc_id: DocId, fn: (editor: unknown) => T | Promise<T>): Promise<T> =>
      sync.transact(doc_id, (ydoc) => fn(ydoc)),
    outbox: () => {
      /* doc.get is a read — no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1,
  };
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
      slug: params.title.toLowerCase(),
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

async function seedDocBlocks(doc_id: DocId, title: string) {
  const seed = [
    { type: "heading", props: { level: 1 }, content: title },
    { type: "paragraph", content: "body text" },
  ] as unknown as LoosePartialBlock[];
  await sync.transact(doc_id, (ydoc) => {
    seedBlocks(ydoc, seed);
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.get", () => {
  it("returns the doc metadata plus the seeded block array", async () => {
    await seedDocRow({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Hello",
      collection_id: COLLECTION_C1,
    });
    await seedDocBlocks(DOC_A1, "Hello");

    const ctx = buildCtx(WORKSPACE_A);
    const out = await docGet.handler(ctx, { doc_id: DOC_A1 });

    expect(out.doc).toMatchObject({
      id: DOC_A1,
      workspace_id: WORKSPACE_A,
      title: "Hello",
      slug: "hello",
      collection_id: COLLECTION_C1,
      visibility: "workspace",
    });
    expect(out.blocks).toHaveLength(2);
    // `DocGetOutput.blocks` is `unknown[]` (the schema keeps the BlockNote
    // block union out of the schemas leaf — ADR 0034; `@editorzero/sync`
    // owns the runtime block contract). The handler still returns the
    // real `LooseBlock[]`; narrow locally to read `type` off each element
    // without widening the schema.
    const [first, second] = out.blocks as Array<{ type?: string }>;
    expect(first?.type).toBe("heading");
    expect(second?.type).toBe("paragraph");
  });

  it("fails closed (InternalError) when the docs row exists but the Y.Doc fragment is empty", async () => {
    // Codex F105 P1 — data-loss safety net. A `docs` row that persists
    // while the Y.Doc state is gone (e.g. MemorySyncService restart)
    // must NOT project as `blocks: []`: a client would read an empty
    // doc and could overwrite the real persisted state on the next
    // `doc.update`. `doc.create` always seeds at least a heading, so
    // zero blocks for an existing row is always a state inconsistency
    // in v1. The honest projection is `InternalError` (500).
    await seedDocRow({ id: DOC_A1, workspace_id: WORKSPACE_A, title: "Empty" });
    const ctx = buildCtx(WORKSPACE_A);
    await expect(docGet.handler(ctx, { doc_id: DOC_A1 })).rejects.toBeInstanceOf(InternalError);
  });

  it("throws NotFoundError when the doc does not exist", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    await expect(docGet.handler(ctx, { doc_id: DOC_MISSING })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("treats soft-deleted docs as not found (invariant 6 — restore owns recovery)", async () => {
    await seedDocRow({
      id: DOC_A2_DELETED,
      workspace_id: WORKSPACE_A,
      title: "Trashed",
      deleted_at: 999,
    });
    const ctx = buildCtx(WORKSPACE_A);
    await expect(docGet.handler(ctx, { doc_id: DOC_A2_DELETED })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot read workspace-B doc", async () => {
    await seedDocRow({ id: DOC_B1, workspace_id: WORKSPACE_B, title: "B1" });
    await seedDocBlocks(DOC_B1, "B1");
    const ctxA = buildCtx(WORKSPACE_A);

    // Same UUID, different workspace — the WorkspaceScopingPlugin
    // injects `workspace_id = A` on the SELECT; the row (owned by B)
    // is invisible, and the handler throws `NotFoundError` rather
    // than leak cross-tenant existence (§8.3(a)).
    await expect(
      ctxA.db.selectFrom("docs").selectAll().where("id", "=", DOC_B1).executeTakeFirst(),
    ).resolves.toBeUndefined();

    await expect(docGet.handler(ctxA, { doc_id: DOC_B1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a non-UUIDv7 doc_id at the input schema", () => {
    // A v4 UUID is a well-formed UUID but not v7; the
    // `z.uuid({ version: "v7" })` rail rejects it with a structured
    // validation issue BEFORE the `.transform(DocId)` brand runs, so
    // the dispatcher gets a clean zod failure (400) instead of an
    // uncaught `TypeError` from `DocId()`'s own UUID-v7 assertion.
    const result = docGet.input.safeParse({
      doc_id: "018f0000-0000-4000-a000-000000000001",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["doc_id"]);
    }
  });

  it("rejects a non-UUID string at the input schema", () => {
    const result = docGet.input.safeParse({ doc_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown input keys (strict)", () => {
    const result = docGet.input.safeParse({
      doc_id: DOC_A1,
      collection_id: COLLECTION_C1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("declares the correct registry metadata", () => {
    expect(docGet.id).toBe("doc.get");
    expect(docGet.category).toBe("read");
    expect(docGet.requires).toEqual(["doc:read"]);
    expect(docGet.surfaces).toEqual(["api", "cli", "mcp"]);
  });

  it("projects a doc subject (per-doc audit granularity)", () => {
    const subject = docGet.audit.subjectFrom({ doc_id: DOC_A1 });
    expect(subject).toEqual({ kind: "doc", id: DOC_A1 });
  });

  it("emits audit.access_log on allow", () => {
    const effect = docGet.audit.effectOnAllow(
      { doc_id: DOC_A1 },
      {
        doc: {
          id: DOC_A1,
          workspace_id: WORKSPACE_A,
          title: "Hello",
          slug: "hello",
          collection_id: null,
          visibility: "workspace",
          created_at: 1,
          updated_at: 1,
        },
        blocks: [],
      },
    );
    expect(effect.kind).toBe("audit.access_log");
  });

  it("emits a deny effect carrying the reason code", () => {
    const effect = docGet.audit.effectOnDeny(
      { doc_id: DOC_A1 },
      { kind: "missing_scope", required: ["doc:read"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.get");
      expect(effect.required_scopes).toEqual(["doc:read"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on not_found via projectErrorAudit", () => {
    // `NotFoundError.toHandlerError()` produces `{ kind: "not_found", ... }`;
    // the shared `projectErrorAudit` helper maps `kind` → `error_code`
    // and derives `retriable=false` for `not_found`. Asserting here
    // locks the audit-log partitioning contract for this capability
    // the same way `doc.list`/`doc.create` tests do.
    const effect = docGet.audit.effectOnError(
      { doc_id: DOC_A1 },
      { kind: "not_found", subject_kind: "doc", subject_id: DOC_A1 },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.get");
      expect(effect.error_code).toBe("not_found");
      expect(effect.retriable).toBe(false);
    }
  });

  it("preserves HandlerError kind on internal failure (empty-fragment safety net)", () => {
    // The `blocks.length === 0` fail-closed path throws `InternalError`,
    // whose `toHandlerError()` returns `{ kind: "internal", trace_id }`.
    // `projectErrorAudit` maps `kind → error_code` and derives
    // `retriable=false` — operator needs to investigate, not a
    // client-retry situation.
    const effect = docGet.audit.effectOnError(
      { doc_id: DOC_A1 },
      { kind: "internal", trace_id: "" },
    );
    expect(effect.kind === "error" && effect.error_code).toBe("internal");
    expect(effect.kind === "error" && effect.retriable).toBe(false);
  });

  it("preserves HandlerError kind on upstream failure (retriable)", () => {
    const effect = docGet.audit.effectOnError(
      { doc_id: DOC_A1 },
      { kind: "upstream", service: "storage", status: 503 },
    );
    expect(effect.kind === "error" && effect.error_code).toBe("upstream");
    expect(effect.kind === "error" && effect.retriable).toBe(true);
  });

  it("collapses per-doc: distinct doc_ids produce distinct keys; same doc_id matches", () => {
    const policy = docGet.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      const keyA = policy.collapseKey({ doc_id: DOC_A1 });
      const keyB = policy.collapseKey({ doc_id: DOC_B1 });
      expect(keyA).not.toBe(keyB);
      expect(keyA).toBe(`doc.get:${DOC_A1}`);
      // F93 SSOT constant — mirror of doc.list's assertion.
      expect(policy.window_ms).toBe(AUDIT_READ_COLLAPSE_WINDOW_MS);
    }
  });
});
