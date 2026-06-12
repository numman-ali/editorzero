/**
 * `collection.list` — capability-level integration test.
 *
 * Runs the handler against a real in-memory SQLite driver so the
 * SQL actually executes. Cross-tenant isolation is owned by
 * `packages/db/src/tenant.unit.test.ts`; this test asserts only
 * that `collection.list` composes with that layer (no manual
 * `workspace_id` predicate — the plugin injects it).
 */

import { AUDIT_READ_COLLAPSE_WINDOW_MS } from "@editorzero/constants";
import { COLLECTIONS_DDL, createSqliteDriver, DOCS_DDL, type SqliteDriver } from "@editorzero/db";
import { CollectionId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { collectionList } from "./list";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");

const COLL_A1 = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const COLL_A2 = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const COLL_A3_DELETED = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const COLL_A_NESTED = CollectionId("018f0000-0000-7000-8000-0000000000c4");
const COLL_B1 = CollectionId("018f0000-0000-7000-8000-0000000000c5");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
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
      throw new Error("transact not exercised by collection.list");
    },
    outbox: () => {
      /* collection.list is a read — no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1,
  };
}

async function seedCollections() {
  const a = driver.scoped(WORKSPACE_A);
  const b = driver.scoped(WORKSPACE_B);

  // Insert out of order to verify the handler orders by order_key.
  await a
    .insertInto("collections")
    .values([
      {
        id: COLL_A2,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "A2",
        slug: "a2",
        order_key: "a1",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: COLL_A1,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "A1",
        slug: "a1",
        order_key: "a0",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: COLL_A_NESTED,
        workspace_id: WORKSPACE_A,
        parent_id: COLL_A1,
        title: "Nested",
        slug: "nested",
        order_key: "a2",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: COLL_A3_DELETED,
        workspace_id: WORKSPACE_A,
        parent_id: null,
        title: "A3 trashed",
        slug: "a3",
        order_key: "a3",
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
        deleted_at: 999,
      },
    ])
    .execute();

  await b
    .insertInto("collections")
    .values({
      id: COLL_B1,
      workspace_id: WORKSPACE_B,
      parent_id: null,
      title: "B1",
      slug: "b1",
      order_key: "b0",
      created_by: ALICE,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("collection.list", () => {
  it("returns an empty list when the workspace has no collections", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    const out = await collectionList.handler(ctx, {});
    expect(out.collections).toEqual([]);
  });

  it("returns non-deleted collections in order_key order", async () => {
    await seedCollections();
    const ctx = buildCtx(WORKSPACE_A);
    const out = await collectionList.handler(ctx, {});
    // A1 (order_key a0), A2 (a1), nested (a2). A3 is soft-deleted.
    expect(out.collections.map((c) => c.id)).toEqual([COLL_A1, COLL_A2, COLL_A_NESTED]);
    expect(out.collections.find((c) => c.id === COLL_A3_DELETED)).toBeUndefined();
  });

  it("projects the expected shape including nullable parent_id", async () => {
    await seedCollections();
    const ctx = buildCtx(WORKSPACE_A);
    const out = await collectionList.handler(ctx, {});
    const root = out.collections.find((c) => c.id === COLL_A1);
    const nested = out.collections.find((c) => c.id === COLL_A_NESTED);
    if (root === undefined || nested === undefined) {
      throw new Error("expected both collections");
    }
    expect(root.parent_id).toBeNull();
    expect(root.title).toBe("A1");
    expect(root.slug).toBe("a1");
    expect(nested.parent_id).toBe(COLL_A1);
    expect(nested.title).toBe("Nested");
  });

  it("composes with Layer-2 scoping: workspace-A handle cannot see workspace-B collections", async () => {
    await seedCollections();
    const ctxA = buildCtx(WORKSPACE_A);
    const ctxB = buildCtx(WORKSPACE_B);

    const outA = await collectionList.handler(ctxA, {});
    const outB = await collectionList.handler(ctxB, {});

    expect(outA.collections.find((c) => c.id === COLL_B1)).toBeUndefined();
    expect(outB.collections.map((c) => c.id)).toEqual([COLL_B1]);
  });

  it("rejects unknown input fields via strict() (no silent drop on typos)", () => {
    const result = collectionList.input.safeParse({ stray: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    }
  });

  it("declares the correct registry metadata", () => {
    expect(collectionList.id).toBe("collection.list");
    expect(collectionList.category).toBe("read");
    expect(collectionList.requires).toEqual(["doc:read"]);
    // "ui" since the sidebar Collections tree landed (proven by the marked
    // Playwright spec; the contract-tests matrix enforces the bond).
    expect(collectionList.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
  });

  it("emits the audit.access_log effect on allow", () => {
    const effect = collectionList.audit.effectOnAllow({}, { collections: [] });
    expect(effect.kind).toBe("audit.access_log");
  });

  it("projects a workspace subject (no per-row subject for a list read)", () => {
    const subject = collectionList.audit.subjectFrom({});
    expect(subject.kind).toBe("workspace");
  });

  it("emits a deny effect carrying the reason code when the gate denies", () => {
    const effect = collectionList.audit.effectOnDeny(
      {},
      { kind: "missing_scope", required: ["doc:read"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("collection.list");
      expect(effect.required_scopes).toEqual(["doc:read"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("emits a non-retriable internal error effect when the handler throws", () => {
    const effect = collectionList.audit.effectOnError({}, { kind: "internal", trace_id: "" });
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("collection.list");
      expect(effect.error_code).toBe("internal");
      expect(effect.retriable).toBe(false);
    }
  });

  it("preserves the HandlerError kind on non-internal failures", () => {
    const effect = collectionList.audit.effectOnError(
      {},
      { kind: "upstream", service: "storage", status: 503 },
    );
    expect(effect.kind === "error" && effect.error_code).toBe("upstream");
    expect(effect.kind === "error" && effect.retriable).toBe(true);
  });

  it("is collapsible with a constant key (no input → always same bucket)", () => {
    const policy = collectionList.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(policy.collapseKey({})).toBe("collection.list");
      expect(policy.window_ms).toBe(AUDIT_READ_COLLAPSE_WINDOW_MS);
    }
  });
});
