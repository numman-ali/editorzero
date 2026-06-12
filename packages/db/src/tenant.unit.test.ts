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

import { DocId, GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { FULL_DDL } from "./drivers/sqlite-ddl";
import { TenantScopeViolationError } from "./tenant";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000b1");

const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_A2 = DocId("018f0000-0000-7000-8000-0000000000d2");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d3");

const SPACE_A = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const SPACE_B = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const GRANT_A = GrantId("018f0000-0000-7000-8000-0000000000f1");
const GRANT_B = GrantId("018f0000-0000-7000-8000-0000000000f2");

// ── Fixture harness ──────────────────────────────────────────────────────
//
// DDL comes from `./drivers/sqlite-ddl` so the test fixture and the
// runtime bootstrap agree on one source of truth (migrates to Atlas
// when that pipeline lands — see `./schema.ts`).

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
  driver.exec(FULL_DDL);
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

  it("SELECT from a typed subquery relies on the inner scope and does not add an outer alias predicate", async () => {
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

    const scopedSubquery = a.selectFrom("docs").selectAll().as("d");
    const compiled = a.selectFrom(scopedSubquery).selectAll().compile();
    expect(compiled.sql).toContain('from (select * from "docs"');
    expect(compiled.sql).toContain('"docs"."workspace_id" = ?');
    expect(compiled.sql).not.toContain('"d"."workspace_id" = ?');

    const rows = await a.selectFrom(scopedSubquery).selectAll().execute();
    expect(rows.map((r) => r.id)).toEqual([DOC_A1]);
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

  it("rejects non-literal workspace_id expressions because they cannot be statically validated", async () => {
    const a = driver.scoped(WORKSPACE_A);
    // `sql<WorkspaceId>` gives the expression the typed brand Kysely's
    // `.values()` expects so this test compiles without casts. At runtime
    // the plugin sees a `RawNode` wrapping the parameter and falls back to
    // the non-literal Symbol sentinel, which trips the mismatch check.
    const expressionBacked = {
      ...seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE),
      workspace_id: sql<WorkspaceId>`${WORKSPACE_A}`,
    };

    await expect(() =>
      a.insertInto("docs").values(expressionBacked).execute(),
    ).rejects.toBeInstanceOf(TenantScopeViolationError);
  });

  it("rejects INSERT … DEFAULT VALUES — no path to set workspace_id", async () => {
    const a = driver.scoped(WORKSPACE_A);
    await expect(() => a.insertInto("docs").defaultValues().execute()).rejects.toBeInstanceOf(
      TenantScopeViolationError,
    );
  });

  it("rejects INSERT … SELECT — plugin cannot guarantee workspace_id in the SELECT body", async () => {
    const a = driver.scoped(WORKSPACE_A);
    // `.expression(...)` fills the InsertQueryNode's `values` with a
    // SelectQueryNode instead of a ValuesNode. The plugin rejects this
    // because it cannot assert the SELECT projects `workspace_id`.
    await expect(() =>
      a
        .insertInto("docs")
        .columns([
          "id",
          "workspace_id",
          "collection_id",
          "title",
          "slug",
          "order_key",
          "visibility",
          "visibility_version",
          "created_by",
          "created_at",
          "updated_at",
          "deleted_at",
        ])
        .expression((eb) => eb.selectFrom("docs").selectAll())
        .execute(),
    ).rejects.toBeInstanceOf(TenantScopeViolationError);
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

  it("UPDATE ... FROM scopes both the target and joined tenant tables", () => {
    const a = driver.scoped(WORKSPACE_A);
    const compiled = a
      .updateTable("docs as target")
      .from("docs as source")
      .set({ title: "renamed" })
      .whereRef("source.id", "=", "target.id")
      .compile();

    expect(compiled.sql).toContain('"target"."workspace_id" = ?');
    expect(compiled.sql).toContain('"source"."workspace_id" = ?');
    expect(compiled.parameters).toContain(WORKSPACE_A);
  });
});

// ── New tenant-scoped tables (F31 write-path schema) ─────────────────────
//
// `doc_snapshots`, `doc_updates`, `audit_events` joined `docs` in
// `TENANT_SCOPED_TABLES` as part of the P3.5 schema expansion;
// `spaces`, `space_members`, `grants` joined in the ADR 0040 Step-4
// slice. The plugin enforcement is table-blind — it keys off
// membership in that list — so these tests prove the list extension
// took effect, not that per-table behaviour is novel. One assertion
// per table: SELECT from workspace A returns zero workspace-B rows.

describe("WorkspaceScopingPlugin — new tenant-scoped tables", () => {
  it("doc_snapshots SELECT is scoped to the caller's workspace", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);

    // `docs` seed first — FK from `doc_snapshots.doc_id`.
    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();
    await b
      .insertInto("docs")
      .values(seedRow(DOC_B1, WORKSPACE_B, "B1", BOB))
      .execute();

    const snapshot = new Uint8Array([0x01, 0x02, 0x03]);
    await a
      .insertInto("doc_snapshots")
      .values({
        id: "snap-a1",
        doc_id: DOC_A1,
        workspace_id: WORKSPACE_A,
        seq: 1,
        state: snapshot,
        created_at: 1,
      })
      .execute();
    await b
      .insertInto("doc_snapshots")
      .values({
        id: "snap-b1",
        doc_id: DOC_B1,
        workspace_id: WORKSPACE_B,
        seq: 1,
        state: snapshot,
        created_at: 1,
      })
      .execute();

    const seenFromA = await a.selectFrom("doc_snapshots").selectAll().execute();
    expect(seenFromA.map((r) => r.id)).toEqual(["snap-a1"]);
  });

  it("doc_updates SELECT is scoped to the caller's workspace", async () => {
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

    const blob = new Uint8Array([0xff]);
    await a
      .insertInto("doc_updates")
      .values({
        id: "upd-a1",
        doc_id: DOC_A1,
        workspace_id: WORKSPACE_A,
        seq: 1,
        update_blob: blob,
        principal_kind: "user",
        principal_id: ALICE,
        session_id: null,
        created_at: 1,
        delete_after: null,
      })
      .execute();
    await b
      .insertInto("doc_updates")
      .values({
        id: "upd-b1",
        doc_id: DOC_B1,
        workspace_id: WORKSPACE_B,
        seq: 1,
        update_blob: blob,
        principal_kind: "user",
        principal_id: BOB,
        session_id: null,
        created_at: 1,
        delete_after: null,
      })
      .execute();

    const seenFromA = await a.selectFrom("doc_updates").selectAll().execute();
    expect(seenFromA.map((r) => r.id)).toEqual(["upd-a1"]);
  });

  it("audit_events SELECT is scoped to the caller's workspace", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);

    const baseRow = {
      capability_id: "doc.list",
      category: "read" as const,
      principal_kind: "user" as const,
      acting_as_user_id: null,
      session_id: null,
      token_id: null,
      subject_kind: "workspace" as const,
      subject_id: null,
      outcome: "allow" as const,
      deny_reason: null,
      input_hash: "0".repeat(64),
      effect: '{"kind":"audit.access_log"}',
      duration_ms: 1,
      trace_id: null,
      created_at: 1,
      collapsed_count: 1,
    };
    await a
      .insertInto("audit_events")
      .values({ id: "aud-a1", workspace_id: WORKSPACE_A, principal_id: ALICE, ...baseRow })
      .execute();
    await b
      .insertInto("audit_events")
      .values({ id: "aud-b1", workspace_id: WORKSPACE_B, principal_id: BOB, ...baseRow })
      .execute();

    const seenFromA = await a.selectFrom("audit_events").selectAll().execute();
    expect(seenFromA.map((r) => r.id)).toEqual(["aud-a1"]);
  });

  function seedSpace(id: SpaceId, workspace_id: WorkspaceId, created_by: UserId) {
    return {
      id,
      workspace_id,
      kind: "team" as const,
      type: "open" as const,
      owner_user_id: null,
      name: "General",
      slug: id,
      baseline_access: "edit" as const,
      created_by,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    };
  }

  it("spaces SELECT is scoped to the caller's workspace", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);

    await a
      .insertInto("spaces")
      .values(seedSpace(SPACE_A, WORKSPACE_A, ALICE))
      .execute();
    await b
      .insertInto("spaces")
      .values(seedSpace(SPACE_B, WORKSPACE_B, BOB))
      .execute();

    const seenFromA = await a.selectFrom("spaces").selectAll().execute();
    expect(seenFromA.map((r) => r.id)).toEqual([SPACE_A]);
  });

  it("space_members SELECT is scoped to the caller's workspace", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);

    // `spaces` seed first — composite FK from `space_members(space_id, workspace_id)`.
    await a
      .insertInto("spaces")
      .values(seedSpace(SPACE_A, WORKSPACE_A, ALICE))
      .execute();
    await b
      .insertInto("spaces")
      .values(seedSpace(SPACE_B, WORKSPACE_B, BOB))
      .execute();

    await a
      .insertInto("space_members")
      .values({
        workspace_id: WORKSPACE_A,
        space_id: SPACE_A,
        user_id: ALICE,
        role: "owner",
        created_at: 1,
        updated_at: 1,
      })
      .execute();
    await b
      .insertInto("space_members")
      .values({
        workspace_id: WORKSPACE_B,
        space_id: SPACE_B,
        user_id: BOB,
        role: "owner",
        created_at: 1,
        updated_at: 1,
      })
      .execute();

    const seenFromA = await a.selectFrom("space_members").selectAll().execute();
    expect(seenFromA.map((r) => r.user_id)).toEqual([ALICE]);
  });

  it("grants SELECT is scoped to the caller's workspace", async () => {
    const a = driver.scoped(WORKSPACE_A);
    const b = driver.scoped(WORKSPACE_B);

    // No parent seed: `grants` carries no FK by design (ADR 0040 H6) —
    // the polymorphic `resource_id` is uncheckable at the DDL layer, so
    // tenant scoping on the table itself is the floor under test here.
    await a
      .insertInto("grants")
      .values({
        id: GRANT_A,
        workspace_id: WORKSPACE_A,
        resource_kind: "doc",
        resource_id: DOC_A1,
        subject_kind: "user",
        subject_id: BOB,
        role: "view",
        is_guest: 1,
        created_by: ALICE,
        created_at: 1,
      })
      .execute();
    await b
      .insertInto("grants")
      .values({
        id: GRANT_B,
        workspace_id: WORKSPACE_B,
        resource_kind: "doc",
        resource_id: DOC_B1,
        subject_kind: "user",
        subject_id: ALICE,
        role: "view",
        is_guest: 1,
        created_by: BOB,
        created_at: 1,
      })
      .execute();

    const seenFromA = await a.selectFrom("grants").selectAll().execute();
    expect(seenFromA.map((r) => r.id)).toEqual([GRANT_A]);
  });
});

// ── Self-scoped table: `workspaces` ──────────────────────────────────────
//
// `workspaces.id` IS the workspace id; the plugin reads
// `TENANT_SCOPE_COLUMNS.workspaces === "id"` and emits `id = <scope>`
// predicates rather than `workspace_id = <scope>`. Same enforcement
// shape, different scope column.

describe("WorkspaceScopingPlugin — self-scoped `workspaces`", () => {
  function seedWorkspace(id: WorkspaceId, slug: string, name: string, created_by: UserId) {
    return {
      id,
      slug,
      name,
      trash_retention_days: 30,
      diagnostic_salt: new Uint8Array(16),
      created_by,
      created_at: 1,
      deleted_at: null,
      settings: "{}",
    };
  }

  it("SELECT through scope A returns only workspace A's row", async () => {
    const sys = driver.system();
    // Bootstrap-style INSERT goes through system handle (the scoped
    // handle would force id = <scope>, which is exactly wrong for a
    // genuine workspace creation).
    await sys
      .insertInto("workspaces")
      .values(seedWorkspace(WORKSPACE_A, "a", "A", ALICE))
      .execute();
    await sys
      .insertInto("workspaces")
      .values(seedWorkspace(WORKSPACE_B, "b", "B", BOB))
      .execute();

    const a = driver.scoped(WORKSPACE_A);
    const seen = await a.selectFrom("workspaces").selectAll().execute();
    expect(seen.map((r) => r.id)).toEqual([WORKSPACE_A]);
  });

  it("INSERT through scoped handle with a mismatched id throws TenantScopeViolationError", async () => {
    const a = driver.scoped(WORKSPACE_A);
    // A scoped caller trying to mint workspace B's row — the plugin
    // sees the explicit `id=WORKSPACE_B` column, compares against the
    // scope (WORKSPACE_A), and throws scope_mismatch. Rejecting at
    // query-build time is the belt-and-suspenders over "you shouldn't
    // be doing this anyway" — workspace.create must go through the
    // system handle by design.
    const bogus = seedWorkspace(WORKSPACE_B, "b", "B", BOB);
    await expect(() => a.insertInto("workspaces").values(bogus).execute()).rejects.toBeInstanceOf(
      TenantScopeViolationError,
    );
  });

  it("UPDATE through scope A cannot touch workspace B's row", async () => {
    const sys = driver.system();
    await sys
      .insertInto("workspaces")
      .values(seedWorkspace(WORKSPACE_A, "a", "A", ALICE))
      .execute();
    await sys
      .insertInto("workspaces")
      .values(seedWorkspace(WORKSPACE_B, "b", "B", BOB))
      .execute();

    const a = driver.scoped(WORKSPACE_A);
    // Naming workspace B explicitly — the plugin's auto-appended
    // `id = WORKSPACE_A` AND-s with the caller's `id = WORKSPACE_B`,
    // producing an always-false predicate → zero rows affected.
    const result = await a
      .updateTable("workspaces")
      .set({ name: "hijacked" })
      .where("id", "=", WORKSPACE_B)
      .execute();
    expect(result[0]?.numUpdatedRows ?? 0n).toBe(0n);

    // B's row untouched.
    const b = driver.scoped(WORKSPACE_B);
    const after = await b.selectFrom("workspaces").selectAll().execute();
    expect(after[0]?.name).toBe("B");
  });

  it("aliased SELECT emits `w.id = ?`, not `w.workspace_id = ?`", () => {
    const a = driver.scoped(WORKSPACE_A);
    const compiled = a.selectFrom("workspaces as w").select("w.id").compile();
    // Positive assertion: the predicate lands on the aliased id.
    expect(compiled.sql).toContain('"w"."id" = ?');
    // Negative assertion: the default column name never appears —
    // `workspaces` has no `workspace_id` column and the plugin must
    // not invent one.
    expect(compiled.sql).not.toContain("workspace_id");
  });
});

// ── Internal tables (outbox / doc_counters) are NOT on the handler surface

describe("TenantScopedDb narrows away internal tables (F98)", () => {
  it("outbox is reachable through driver.system() — the poller's escape hatch", async () => {
    // The outbox poller is a system-level service; it drains rows
    // across workspaces. It uses `driver.system()` (no plugin, no
    // `workspace_id` predicate) so it can see every pending event.
    // Handler-facing code cannot reach `outbox` through the scoped
    // handle — the type signature hides it, and the compile-test
    // below pins that narrowing in place.
    const sys = driver.system();

    await sys
      .insertInto("outbox")
      .values([
        {
          id: "out-a",
          workspace_id: WORKSPACE_A,
          event: "doc.updated",
          payload: "{}",
          created_at: 1,
          forwarded_at: null,
          forwarded_to: null,
        },
        {
          id: "out-b",
          workspace_id: WORKSPACE_B,
          event: "doc.updated",
          payload: "{}",
          created_at: 1,
          forwarded_at: null,
          forwarded_to: null,
        },
      ])
      .execute();

    const seen = await sys.selectFrom("outbox").selectAll().execute();
    expect(seen.map((r) => r.id).sort()).toEqual(["out-a", "out-b"]);
  });

  it("doc_counters is reachable through driver.system() — the dispatcher's write-path tx", async () => {
    // `doc_counters` has no `workspace_id` column; seq allocation
    // inside the write-path tx uses `driver.system()` so the scoping
    // plugin doesn't try to predicate it. Proof that the system
    // handle can INSERT and SELECT the counter row.
    const sys = driver.system();
    const a = driver.scoped(WORKSPACE_A);

    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();
    await sys
      .insertInto("doc_counters")
      .values({ doc_id: DOC_A1, next_seq: 1, updated_at: 1 })
      .execute();

    const seen = await sys
      .selectFrom("doc_counters")
      .select(["doc_id", "next_seq"])
      .where("doc_id", "=", DOC_A1)
      .execute();
    expect(seen).toEqual([{ doc_id: DOC_A1, next_seq: 1 }]);
  });

  it("handler-facing TenantScopedDb cannot name outbox or doc_counters (compile-time guard)", () => {
    const a = driver.scoped(WORKSPACE_A);
    // If either of these stops erroring, a regression widened the
    // handler-visible `Database` type — F98's narrowing is the point.
    // @ts-expect-error — outbox lives on SystemDatabase, not Database
    a.selectFrom("outbox");
    // @ts-expect-error — doc_counters lives on SystemDatabase, not Database
    a.selectFrom("doc_counters");
    expect(true).toBe(true);
  });
});

// ── Composite FK: doc_id/workspace_id consistency (F99) ──────────────────
//
// The scoping plugin enforces `workspace_id = <scope>` on every query
// but does not verify that `doc_id` belongs to that workspace — a
// bug (or the unscoped system handle) could otherwise pair a valid
// `doc_id` with a wrong `workspace_id` and silently corrupt the
// replay path. The DDL adds a composite FK `(doc_id, workspace_id)
// REFERENCES docs(id, workspace_id)` on `doc_snapshots` and
// `doc_updates`; these tests prove the FK fires even through the
// unscoped system handle.

describe("Composite (doc_id, workspace_id) FK (F99)", () => {
  it("doc_snapshots rejects a mismatched workspace_id even through driver.system()", async () => {
    const sys = driver.system();
    const a = driver.scoped(WORKSPACE_A);

    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();

    const snapshot = new Uint8Array([0x01]);
    await expect(() =>
      sys
        .insertInto("doc_snapshots")
        .values({
          id: "snap-bad",
          doc_id: DOC_A1,
          // Doc A1 belongs to workspace A; claiming workspace B here
          // must fail at the composite FK.
          workspace_id: WORKSPACE_B,
          seq: 1,
          state: snapshot,
          created_at: 1,
        })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("doc_updates rejects a mismatched workspace_id even through driver.system()", async () => {
    const sys = driver.system();
    const a = driver.scoped(WORKSPACE_A);

    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();

    const blob = new Uint8Array([0xff]);
    await expect(() =>
      sys
        .insertInto("doc_updates")
        .values({
          id: "upd-bad",
          doc_id: DOC_A1,
          workspace_id: WORKSPACE_B,
          seq: 1,
          update_blob: blob,
          principal_kind: "user",
          principal_id: ALICE,
          session_id: null,
          created_at: 1,
          delete_after: null,
        })
        .execute(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("doc_snapshots accepts a matching workspace_id (sanity: the FK passes the happy path)", async () => {
    const sys = driver.system();
    const a = driver.scoped(WORKSPACE_A);

    await a
      .insertInto("docs")
      .values(seedRow(DOC_A1, WORKSPACE_A, "A1", ALICE))
      .execute();

    const snapshot = new Uint8Array([0x01]);
    await sys
      .insertInto("doc_snapshots")
      .values({
        id: "snap-ok",
        doc_id: DOC_A1,
        workspace_id: WORKSPACE_A,
        seq: 1,
        state: snapshot,
        created_at: 1,
      })
      .execute();

    const seen = await sys.selectFrom("doc_snapshots").select("id").execute();
    expect(seen).toEqual([{ id: "snap-ok" }]);
  });
});
