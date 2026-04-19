/**
 * Tenant-scoping conformance across SQLite + Postgres (ADR 0023 §4).
 *
 * `tenant.unit.test.ts` already proves the WorkspaceScopingPlugin's
 * SQL-AST surgery against SQLite at the unit level. This harness is
 * the cross-dialect floor: given the *same* plugin runs against both
 * drivers, assert the *observable* invariant (a workspace-A handle
 * cannot observe workspace-B rows) holds on PG too — where the
 * underlying SQL emitter, type coercion, and locking primitives all
 * differ from SQLite.
 *
 * A SELECT / INSERT / cross-tenant case is enough to floor the
 * invariant; exhaustive AST-shape coverage stays in the unit test.
 * If a future Postgres-only regression in query-plan / parameter-
 * binding ever breaks scoping on PG but not SQLite, the SELECT /
 * INSERT pair here surfaces it.
 */

import { DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TenantScopeViolationError } from "../../src/tenant";
import {
  type Backend,
  createPostgresBackend,
  createSqliteBackend,
  SKIP_POSTGRES,
} from "./backends";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000b1");
const DOC_A1 = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_B1 = DocId("018f0000-0000-7000-8000-0000000000d3");

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

// Spin backends once per file. `describe.each` over the list
// parametrises every suite by dialect.
const backends: Array<{ name: "sqlite" | "postgres"; setup: () => Promise<Backend> }> = [
  { name: "sqlite", setup: createSqliteBackend },
];
if (!SKIP_POSTGRES) {
  backends.push({
    name: "postgres",
    setup: async () => (await createPostgresBackend()).backend,
  });
}

describe.each(backends)("tenant-scoping — $name", ({ setup }) => {
  let backend: Backend;

  beforeAll(async () => {
    backend = await setup();
  }, 120_000);

  afterAll(async () => {
    await backend.close();
  }, 60_000);

  beforeEach(async () => {
    await backend.resetSchema();
  });

  afterEach(async () => {
    // No-op; beforeEach wipes next run.
  });

  it("a workspace-A handle never returns workspace-B rows", async () => {
    const base = backend.driver.system();
    await base
      .insertInto("docs")
      .values([
        seedRow(DOC_A1, WORKSPACE_A, "A doc", ALICE),
        seedRow(DOC_B1, WORKSPACE_B, "B doc", BOB),
      ])
      .execute();

    const a = backend.driver.scoped(WORKSPACE_A);
    const rows = await a.selectFrom("docs").select(["id", "title"]).execute();

    expect(rows.map((r) => r.id)).toEqual([DOC_A1]);
  });

  it("INSERT through a workspace-A handle auto-populates workspace_id even when omitted", async () => {
    const a = backend.driver.scoped(WORKSPACE_A);

    // Strip `workspace_id` so the scoping plugin's INSERT injection is what
    // writes it. The cast is the cost of asserting runtime behaviour the
    // static types can't model — see `tenant.unit.test.ts` for the same
    // pattern.
    const { workspace_id: _omitted, ...rowWithoutScope } = seedRow(
      DOC_A1,
      WORKSPACE_A,
      "A doc",
      ALICE,
    );
    void _omitted;
    // @ts-expect-error workspace_id intentionally omitted — plugin injects it at runtime.
    await a.insertInto("docs").values(rowWithoutScope).execute();

    // Read back through `system()` (no plugin) to confirm the persisted
    // workspace_id matches the scope. Proves the plugin writes the DB,
    // not just the AST.
    const rows = await backend.driver
      .system()
      .selectFrom("docs")
      .select(["id", "workspace_id"])
      .execute();
    expect(rows).toEqual([{ id: DOC_A1, workspace_id: WORKSPACE_A }]);
  });

  it("INSERT with a workspace_id that disagrees with the scope throws TenantScopeViolationError", async () => {
    const a = backend.driver.scoped(WORKSPACE_A);
    await expect(
      a
        .insertInto("docs")
        .values(seedRow(DOC_A1, WORKSPACE_B, "B smuggle", ALICE))
        .execute(),
    ).rejects.toBeInstanceOf(TenantScopeViolationError);
  });

  it("SELECT emitted SQL carries the workspace_id predicate on both dialects (regression floor)", async () => {
    const a = backend.driver.scoped(WORKSPACE_A);
    const compiled = a.selectFrom("docs").select("id").compile();
    // Both dialects quote `workspace_id`; the predicate literal differs
    // (`?` on SQLite, `$1` on PG) so we assert a dialect-tolerant
    // substring.
    expect(compiled.sql).toMatch(/"docs"\."workspace_id" = (\$\d+|\?)/);
  });
});
