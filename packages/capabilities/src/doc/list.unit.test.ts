/**
 * `doc.list` — capability-level integration test.
 *
 * Tests the handler directly against a real in-memory SQLite driver
 * so the SQL actually executes. Layer-2 cross-tenant isolation is
 * owned by `packages/db/src/tenant.unit.test.ts`; here we confirm
 * only that `doc.list` composes with that layer (queries don't
 * re-export workspace_id, still get the scope auto-applied).
 *
 * Dispatcher wiring (audit row emission, zod parse, gate) is the
 * dispatcher's test. The capability's unit test asserts handler
 * semantics on the real db.
 */

import { createSqliteDriver, type SqliteDriver } from "@editorzero/db";
import { CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docList } from "./list";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const COLLECTION_C1 = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2 = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_A3_DELETED = DocId("018f0000-0000-7000-8000-0000000000d3");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d4");

const DOCS_DDL = `
  CREATE TABLE docs (
    id                 TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL,
    collection_id      TEXT,
    title              TEXT NOT NULL,
    slug               TEXT NOT NULL,
    order_key          TEXT NOT NULL,
    visibility         TEXT NOT NULL DEFAULT 'workspace',
    visibility_version INTEGER NOT NULL DEFAULT 0,
    created_by         TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    deleted_at         INTEGER
  );
`;

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(DOCS_DDL);
});

afterEach(async () => {
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

function buildCtx(workspace_id: WorkspaceId): CapabilityContext {
  return {
    principal: userPrincipal(),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    transact: async () => {
      throw new Error("transact not exercised by doc.list");
    },
    outbox: () => {
      /* doc.list is a read — no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1,
  };
}

async function seedDocs() {
  const a = driver.scoped(WORKSPACE_A);
  const b = driver.scoped(WORKSPACE_B);

  // Insert out of order_key sequence to verify the handler orders them.
  await a
    .insertInto("docs")
    .values([
      {
        id: DOC_A2,
        workspace_id: WORKSPACE_A,
        collection_id: COLLECTION_C1,
        title: "A2",
        slug: "a2",
        order_key: "a1",
        visibility: "workspace",
        visibility_version: 0,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: DOC_A1,
        workspace_id: WORKSPACE_A,
        collection_id: null,
        title: "A1",
        slug: "a1",
        order_key: "a0",
        visibility: "public",
        visibility_version: 0,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: DOC_A3_DELETED,
        workspace_id: WORKSPACE_A,
        collection_id: null,
        title: "A3 deleted",
        slug: "a3",
        order_key: "a2",
        visibility: "workspace",
        visibility_version: 0,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 999,
      },
    ])
    .execute();

  await b
    .insertInto("docs")
    .values({
      id: DOC_B1,
      workspace_id: WORKSPACE_B,
      collection_id: null,
      title: "B1",
      slug: "b1",
      order_key: "a0",
      visibility: "workspace",
      visibility_version: 0,
      created_by: ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.list", () => {
  it("returns an empty list when the workspace has no docs", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    const out = await docList.handler(ctx, {});
    expect(out.docs).toEqual([]);
  });

  it("returns non-deleted docs in order_key order", async () => {
    await seedDocs();
    const ctx = buildCtx(WORKSPACE_A);
    const out = await docList.handler(ctx, {});
    expect(out.docs.map((d) => d.id)).toEqual([DOC_A1, DOC_A2]);
    // Soft-deleted doc absent.
    expect(out.docs.find((d) => d.id === DOC_A3_DELETED)).toBeUndefined();
  });

  it("projects the expected shape including nullable collection_id and visibility", async () => {
    await seedDocs();
    const ctx = buildCtx(WORKSPACE_A);
    const out = await docList.handler(ctx, {});
    const [first, second] = out.docs;
    if (first === undefined || second === undefined) {
      throw new Error("expected two docs");
    }
    expect(first).toMatchObject({
      id: DOC_A1,
      title: "A1",
      slug: "a1",
      collection_id: null,
      visibility: "public",
    });
    expect(second).toMatchObject({
      id: DOC_A2,
      title: "A2",
      slug: "a2",
      collection_id: COLLECTION_C1,
      visibility: "workspace",
    });
  });

  it("composes with Layer-2 scoping: a workspace-A handle cannot see workspace-B docs", async () => {
    await seedDocs();
    const ctxA = buildCtx(WORKSPACE_A);
    const ctxB = buildCtx(WORKSPACE_B);

    const outA = await docList.handler(ctxA, {});
    const outB = await docList.handler(ctxB, {});

    expect(outA.docs.map((d) => d.id).sort()).toEqual([DOC_A1, DOC_A2].sort());
    expect(outB.docs.map((d) => d.id)).toEqual([DOC_B1]);
  });

  it("declares the correct registry metadata", () => {
    expect(docList.id).toBe("doc.list");
    expect(docList.category).toBe("read");
    expect(docList.requires).toEqual(["doc:read"]);
    expect(docList.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
  });

  it("emits the audit.access_log effect on allow", () => {
    const effect = docList.audit.effectOnAllow({}, { docs: [] });
    expect(effect.kind).toBe("audit.access_log");
  });

  it("is collapsible with a constant key (no input → always same bucket)", () => {
    const policy = docList.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(policy.collapseKey({})).toBe("doc.list");
      expect(policy.window_ms).toBe(1000);
    }
  });
});
