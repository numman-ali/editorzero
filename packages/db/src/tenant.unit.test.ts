/**
 * Tenant-scoping integration tests against real in-memory SQLite.
 *
 * These are the Layer-2 floor proofs (architecture.md §8.1a). For each
 * of SELECT / INSERT / UPDATE / DELETE against the tenant-scoped
 * `docs` table, assert that a `TenantScopedDb` bound to workspace A
 * cannot observe or mutate rows owned by workspace B, even when the
 * caller writes the query without a `workspace_id` predicate.
 *
 * These tests run against a real driver rather than a plugin-only
 * snapshot because the invariant we care about is observable
 * behaviour on a real database — not emitted SQL. The plugin's
 * AST surgery is the implementation; the invariant is the output.
 */

import { DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { TenantScopeViolationError } from "./tenant";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000b1");

const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2 = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d3");

// ── Fixture harness ──────────────────────────────────────────────────────

/**
 * `docs` DDL mirrors architecture.md §3.5 for the columns this slice
 * exercises. It is hand-written until Atlas + kysely-codegen land
 * (see `./schema.ts`); when they do, the migration will come from
 * `packages/db/src/schema/*.sql`.
 */
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

function seedRow(id: DocId, workspace_id: WorkspaceId, title: string, created_by: UserId) {
  return {
    id,
    workspace_id,
    collection_id: null,
    title,
    slug: id,
    order_key: "a0",
    visibility: "workspace" as const,
    visibility_version: 0,
    created_by,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(DOCS_DDL);
});

afterEach(async () => {
  await driver.close();
});

// ── Scenarios ────────────────────────────────────────────────────────────

describe("WorkspaceScopingPlugin — SELECT", () => {
  it("a workspace-A handle never returns workspace-B rows, even without a predicate", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);

    await a
      .insertInto("docs")
      .values([
        seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE),
        seedRow(DOC_A2, WORKSPACE_A, "A2", ALICE),
      ])
      .execute();
    await b
      .insertInto("docs")
      .values([seedRow(DOC_B1, WORKSPACE_B, "B1", BOB)])
      .execute();

    const rowsA = await a.selectFrom("docs").selectAll().execute();
    expect(rowsA.map((r) => r.id).sort()).toEqual([DOC_A1, DOC_A2].sort());

    const rowsB = await b.selectFrom("docs").selectAll().execute();
    expect(rowsB.map((r) => r.id)).toEqual([DOC_B1]);
  });

  it("explicit filters AND with the scope predicate", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);
    await a
      .insertInto("docs")
      .values([
        seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE),
        seedRow(DOC_A2, WORKSPACE_A, "A2", ALICE),
      ])
      .execute();
    await b
      .insertInto("docs")
      .values([seedRow(DOC_B1, WORKSPACE_B, "B1", BOB)])
      .execute();

    const byTitle = await a.selectFrom("docs").selectAll().where("title", "=", "A1").execute();
    expect(byTitle.map((r) => r.id)).toEqual([DOC_A1]);

    // workspace A querying for a title only present in workspace B returns nothing.
    const crossed = await a.selectFrom("docs").selectAll().where("title", "=", "B1").execute();
    expect(crossed).toEqual([]);
  });
});

describe("WorkspaceScopingPlugin — INSERT", () => {
  it("injects the scope workspace_id when the caller omits it", async () => {
    const a = driver.scoped(WORKSPACE_A);

    // `insertInto(...).values({...without workspace_id...})` — Kysely
    // emits an INSERT with an explicit columns list; the plugin
    // appends `workspace_id` to both columns and row values at AST-
    // transform time, after Kysely's types have already decided the
    // call site is "incomplete". The type error below is the cost
    // of asserting runtime behavior the static types can't model.
    const row = seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE);
    const { workspace_id: _, ...rowWithoutScope } = row;
    void _;
    // @ts-expect-error workspace_id intentionally omitted — plugin injects it at runtime.
    await a.insertInto("docs").values(rowWithoutScope).execute();

    const seen = await a.selectFrom("docs").selectAll().execute();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.workspace_id).toBe(WORKSPACE_A);
  });

  it("accepts a matching workspace_id without a thrown violation", async () => {
    const a = driver.scoped(WORKSPACE_A);
    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();
    const seen = await a.selectFrom("docs").selectAll().execute();
    expect(seen).toHaveLength(1);
  });

  it("throws TenantScopeViolationError when the explicit workspace_id disagrees with the scope", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const bogus = seedRow(DOC_A1, WORKSPACE_B, "smuggled", ALICE);
    await expect(() => a.insertInto("docs").values(bogus).execute()).rejects.toBeInstanceOf(
      TenantScopeViolationError,
    );
  });
});

describe("WorkspaceScopingPlugin — UPDATE", () => {
  it("the scope predicate prevents touching other workspaces' rows", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);
    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();
    await b
      .insertInto("docs")
      .values(seedRow(DOC_B1, WORKSPACE_B, "B1", BOB))
      .execute();

    // Workspace A tries to rename "every doc". Without the plugin,
    // this would rewrite B1 too — with it, only A1 is touched.
    const result = await a.updateTable("docs").set({ title: "renamed" }).executeTakeFirst();
    expect(result.numUpdatedRows).toBe(1n);

    const bRows = await b.selectFrom("docs").selectAll().execute();
    expect(bRows[0]?.title).toBe("B1");
  });
});

describe("WorkspaceScopingPlugin — DELETE", () => {
  it("the scope predicate prevents deleting other workspaces' rows", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);
    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();
    await b
      .insertInto("docs")
      .values(seedRow(DOC_B1, WORKSPACE_B, "B1", BOB))
      .execute();

    const result = await a.deleteFrom("docs").executeTakeFirst();
    expect(result.numDeletedRows).toBe(1n);

    const bStillThere = await b.selectFrom("docs").selectAll().execute();
    expect(bStillThere).toHaveLength(1);
  });
});

// ── F87: alias-aware + join-aware scoping ────────────────────────────────
//
// The predicate must target whichever identifier the surrounding SQL
// uses. For an unaliased `docs` that's `docs.workspace_id`; for
// `docs AS d` the emitted SQL is invalid unless the predicate says
// `d.workspace_id`. Same story for joined tenant tables — every
// participant must be scoped independently, or the join product leaks
// cross-workspace rows.

describe("WorkspaceScopingPlugin — alias awareness (F87)", () => {
  it("SELECT with an alias emits the predicate against the alias (legal SQL)", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const { sql, parameters } = a.selectFrom("docs as d").selectAll().compile();
    expect(sql).toContain('"d"."workspace_id" = ?');
    expect(sql).not.toContain('"docs"."workspace_id" = ?');
    expect(parameters).toContain(WORKSPACE_A);
  });

  it("SELECT with an alias runs against SQLite and honours the scope", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);
    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();
    await b
      .insertInto("docs")
      .values(seedRow(DOC_B1, WORKSPACE_B, "B1", BOB))
      .execute();

    // Before F87 this threw `no such column: docs.workspace_id` because
    // the plugin emitted the un-aliased table in the predicate.
    const rows = await a.selectFrom("docs as d").selectAll().execute();
    expect(rows.map((r) => r.id)).toEqual([DOC_A1]);
  });

  it("DELETE with an alias emits the alias predicate and only touches the scope", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);
    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();
    await b
      .insertInto("docs")
      .values(seedRow(DOC_B1, WORKSPACE_B, "B1", BOB))
      .execute();

    const compiled = a.deleteFrom("docs as d").compile();
    expect(compiled.sql).toContain('"d"."workspace_id" = ?');

    const result = await a.deleteFrom("docs as d").executeTakeFirst();
    expect(result.numDeletedRows).toBe(1n);

    const bStillThere = await b.selectFrom("docs").selectAll().execute();
    expect(bStillThere).toHaveLength(1);
  });

  it("UPDATE with an alias emits the alias predicate and only touches the scope", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);
    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();
    await b
      .insertInto("docs")
      .values(seedRow(DOC_B1, WORKSPACE_B, "B1", BOB))
      .execute();

    const compiled = a.updateTable("docs as d").set({ title: "renamed" }).compile();
    expect(compiled.sql).toContain('"d"."workspace_id" = ?');

    const result = await a.updateTable("docs as d").set({ title: "renamed" }).executeTakeFirst();
    expect(result.numUpdatedRows).toBe(1n);

    const bRows = await b.selectFrom("docs").selectAll().execute();
    expect(bRows[0]?.title).toBe("B1");
  });
});

describe("WorkspaceScopingPlugin — join awareness (F87)", () => {
  it("aliased self-join scopes every tenant participant independently", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);
    await a
      .insertInto("docs")
      .values([
        seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE),
        seedRow(DOC_A2, WORKSPACE_A, "A2", ALICE),
      ])
      .execute();
    await b
      .insertInto("docs")
      .values([seedRow(DOC_B1, WORKSPACE_B, "B1", BOB)])
      .execute();

    // `parent INNER JOIN child ON child.id = parent.id` is a self-join
    // that pairs each doc with itself — one row per scoped doc. Before
    // F87, neither `parent` nor `child` got a workspace predicate, so
    // cross-workspace rows could appear in the join product.
    const compiled = a
      .selectFrom("docs as parent")
      .innerJoin("docs as child", "child.id", "parent.id")
      .select(["parent.id as p_id", "child.id as c_id"])
      .compile();
    expect(compiled.sql).toContain('"parent"."workspace_id" = ?');
    expect(compiled.sql).toContain('"child"."workspace_id" = ?');

    const rows = await a
      .selectFrom("docs as parent")
      .innerJoin("docs as child", "child.id", "parent.id")
      .select(["parent.id as p_id", "child.id as c_id"])
      .execute();
    expect(rows.map((r) => r.p_id).sort()).toEqual([DOC_A1, DOC_A2].sort());
    expect(rows.every((r) => r.p_id === r.c_id)).toBe(true);
  });
});
