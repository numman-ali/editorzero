/**
 * Per-table tenant-isolation floor across SQLite + Postgres
 * (ADR 0023 §4 / Appendix C item 5 — "F4 cross-tenant against both drivers").
 *
 * `tenant-scoping.integration.test.ts` proves the WorkspaceScopingPlugin
 * instruments the compiled SQL on both dialects against the `docs` table.
 * This file extends the floor to every member of `TENANT_SCOPED_TABLES`
 * (`collections`, `docs`, `doc_snapshots`, `doc_updates`, `audit_events`)
 * — the plugin is table-blind by design (it keys off list membership),
 * so the invariant we care about is not "does it work on table X" but
 * "does it actually run against table X on Postgres". `tenant.unit.test.ts`
 * has already covered each table on SQLite at the unit level.
 *
 * Shape: one test per table × backend, each seeds a row in workspace A
 * and workspace B via the unscoped `system()` handle, then asserts the
 * workspace-A scoped handle returns only the A row. Parent-FK rows
 * (`docs`) are seeded first where required (`doc_snapshots` /
 * `doc_updates` depend on `docs.id`; `audit_events` does not).
 */

import { CapabilityId, CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TENANT_SCOPED_TABLES } from "../../src/schema";
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
const DOC_A = DocId("018f0000-0000-7000-8000-0000000000d1");
const DOC_B = DocId("018f0000-0000-7000-8000-0000000000d2");
const COLL_A = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const COLL_B = CollectionId("018f0000-0000-7000-8000-0000000000c2");

function seedDoc(id: DocId, workspace_id: WorkspaceId, created_by: UserId) {
  return {
    id,
    workspace_id,
    collection_id: null,
    title: "doc",
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

async function seedDocsBothWorkspaces(backend: Backend) {
  await backend.driver
    .system()
    .insertInto("docs")
    .values([seedDoc(DOC_A, WORKSPACE_A, ALICE), seedDoc(DOC_B, WORKSPACE_B, BOB)])
    .execute();
}

const BLOB = new Uint8Array([0x01, 0x02, 0x03]);

const backends: Array<{ name: "sqlite" | "postgres"; setup: () => Promise<Backend> }> = [
  { name: "sqlite", setup: createSqliteBackend },
];
if (!SKIP_POSTGRES) {
  backends.push({
    name: "postgres",
    setup: async () => (await createPostgresBackend()).backend,
  });
}

describe.each(backends)("tenant-table isolation — $name", ({ setup }) => {
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

  it("every TENANT_SCOPED_TABLES member is covered by a per-table test — drift guard", () => {
    // If this list grows and a test below isn't added, the assertion
    // catches the drift so the floor keeps matching the schema.
    expect([...TENANT_SCOPED_TABLES]).toEqual([
      "collections",
      "docs",
      "doc_snapshots",
      "doc_updates",
      "audit_events",
    ]);
  });

  it("collections: workspace-A handle returns only workspace-A rows", async () => {
    await backend.driver
      .system()
      .insertInto("collections")
      .values([
        {
          id: COLL_A,
          workspace_id: WORKSPACE_A,
          parent_id: null,
          title: "coll",
          slug: "coll-a",
          order_key: COLL_A,
          created_by: ALICE,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        },
        {
          id: COLL_B,
          workspace_id: WORKSPACE_B,
          parent_id: null,
          title: "coll",
          slug: "coll-b",
          order_key: COLL_B,
          created_by: BOB,
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
        },
      ])
      .execute();

    const a = backend.driver.scoped(WORKSPACE_A);
    const seen = await a.selectFrom("collections").select("id").execute();
    expect(seen.map((r) => r.id)).toEqual([COLL_A]);
  });

  it("docs: workspace-A handle returns only workspace-A rows", async () => {
    await seedDocsBothWorkspaces(backend);
    const a = backend.driver.scoped(WORKSPACE_A);
    const seen = await a.selectFrom("docs").select("id").execute();
    expect(seen.map((r) => r.id)).toEqual([DOC_A]);
  });

  it("doc_snapshots: workspace-A handle returns only workspace-A rows", async () => {
    await seedDocsBothWorkspaces(backend);
    await backend.driver
      .system()
      .insertInto("doc_snapshots")
      .values([
        {
          id: "snap-a",
          doc_id: DOC_A,
          workspace_id: WORKSPACE_A,
          seq: 1,
          state: BLOB,
          created_at: 1,
        },
        {
          id: "snap-b",
          doc_id: DOC_B,
          workspace_id: WORKSPACE_B,
          seq: 1,
          state: BLOB,
          created_at: 1,
        },
      ])
      .execute();

    const a = backend.driver.scoped(WORKSPACE_A);
    const seen = await a.selectFrom("doc_snapshots").select("id").execute();
    expect(seen.map((r) => r.id)).toEqual(["snap-a"]);
  });

  it("doc_updates: workspace-A handle returns only workspace-A rows", async () => {
    await seedDocsBothWorkspaces(backend);
    await backend.driver
      .system()
      .insertInto("doc_updates")
      .values([
        {
          id: "upd-a",
          doc_id: DOC_A,
          workspace_id: WORKSPACE_A,
          seq: 1,
          update_blob: BLOB,
          principal_kind: "user",
          principal_id: ALICE,
          session_id: null,
          created_at: 1,
          delete_after: null,
        },
        {
          id: "upd-b",
          doc_id: DOC_B,
          workspace_id: WORKSPACE_B,
          seq: 1,
          update_blob: BLOB,
          principal_kind: "user",
          principal_id: BOB,
          session_id: null,
          created_at: 1,
          delete_after: null,
        },
      ])
      .execute();

    const a = backend.driver.scoped(WORKSPACE_A);
    const seen = await a.selectFrom("doc_updates").select("id").execute();
    expect(seen.map((r) => r.id)).toEqual(["upd-a"]);
  });

  it("audit_events: workspace-A handle returns only workspace-A rows", async () => {
    await backend.driver
      .system()
      .insertInto("audit_events")
      .values([
        {
          id: "aud-a",
          workspace_id: WORKSPACE_A,
          capability_id: CapabilityId("doc.list"),
          category: "read",
          principal_kind: "user",
          principal_id: ALICE,
          acting_as_user_id: null,
          session_id: null,
          token_id: null,
          subject_kind: "workspace",
          subject_id: null,
          outcome: "allow",
          deny_reason: null,
          input_hash: "0".repeat(64),
          effect: '{"kind":"audit.access_log"}',
          duration_ms: 1,
          trace_id: null,
          created_at: 1,
          collapsed_count: 1,
        },
        {
          id: "aud-b",
          workspace_id: WORKSPACE_B,
          capability_id: CapabilityId("doc.list"),
          category: "read",
          principal_kind: "user",
          principal_id: BOB,
          acting_as_user_id: null,
          session_id: null,
          token_id: null,
          subject_kind: "workspace",
          subject_id: null,
          outcome: "allow",
          deny_reason: null,
          input_hash: "0".repeat(64),
          effect: '{"kind":"audit.access_log"}',
          duration_ms: 1,
          trace_id: null,
          created_at: 1,
          collapsed_count: 1,
        },
      ])
      .execute();

    const a = backend.driver.scoped(WORKSPACE_A);
    const seen = await a.selectFrom("audit_events").select("id").execute();
    expect(seen.map((r) => r.id)).toEqual(["aud-a"]);
  });
});
