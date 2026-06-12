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

import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  DOCS_DDL,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
} from "@editorzero/db";
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

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
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
        access_mode: "space",
        published_slug: null,
        published_at: null,
        render_version: 0,
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
        // Published doc — exercises the non-null publish pair through the
        // list projection (ADR 0040 Step 5).
        access_mode: "space",
        published_slug: "a1",
        published_at: 777,
        render_version: 1,
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
        access_mode: "space",
        published_slug: null,
        published_at: null,
        render_version: 0,
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
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
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

  it("projects the expected shape including nullable collection_id and the publish pair", async () => {
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
      access_mode: "space",
      published_slug: "a1",
      published_at: 777,
    });
    expect(second).toMatchObject({
      id: DOC_A2,
      title: "A2",
      slug: "a2",
      collection_id: COLLECTION_C1,
      access_mode: "space",
      published_slug: null,
      published_at: null,
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

  it("projects a workspace subject (no per-row subject for a list read)", () => {
    const subject = docList.audit.subjectFrom({});
    expect(subject.kind).toBe("workspace");
  });

  it("emits a deny effect carrying the reason code when the gate denies", () => {
    const effect = docList.audit.effectOnDeny(
      {},
      { kind: "missing_scope", required: ["doc:read"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("doc.list");
      expect(effect.required_scopes).toEqual(["doc:read"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("emits a non-retriable internal error effect when the handler throws", () => {
    const effect = docList.audit.effectOnError({}, { kind: "internal", trace_id: "" });
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.list");
      expect(effect.error_code).toBe("internal");
      expect(effect.retriable).toBe(false);
    }
  });

  it("preserves the HandlerError kind on non-internal failures (audit log partitioning)", () => {
    // The shared `projectErrorAudit` helper preserves `error.kind` on
    // the audit row and derives `retriable` per-kind — same contract
    // as doc.create, for the same reason (Codex F102 P2 finding).
    const effect = docList.audit.effectOnError(
      {},
      { kind: "upstream", service: "storage", status: 503 },
    );
    expect(effect.kind === "error" && effect.error_code).toBe("upstream");
    expect(effect.kind === "error" && effect.retriable).toBe(true);
  });

  it("is collapsible with a constant key (no input → always same bucket)", () => {
    const policy = docList.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(policy.collapseKey({})).toBe("doc.list");
      // F93: window sourced from `@editorzero/constants`, not a local
      // literal — the collapse-window floor moves workspace-wide if
      // the SSOT constant changes.
      expect(policy.window_ms).toBe(AUDIT_READ_COLLAPSE_WINDOW_MS);
    }
  });
});
