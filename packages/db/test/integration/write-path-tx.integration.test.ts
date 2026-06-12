/**
 * `withSystemTx` atomicity conformance across SQLite + Postgres
 * (ADR 0023 §3 / ADR 0018 write-path tx).
 *
 * `withSystemTx` is the single primitive the dispatcher's write path
 * (F31) stands on: every mutation slice commits `docs` +
 * `doc_updates` + `audit_events` + `outbox` + `doc_counters.next_seq`
 * atomically or not at all. The invariant we care about is
 * dialect-agnostic — PG's `SERIALIZABLE` and SQLite's
 * `BEGIN IMMEDIATE` are mapped from the same Kysely signal
 * (`setIsolationLevel("serializable")`) by each driver's dialect.
 *
 * This harness asserts:
 *  - A successful `withSystemTx` commits all mutations.
 *  - A `withSystemTx` whose body throws rolls back every mutation
 *    (including those enqueued before the throw).
 *  - Inside the tx, reads see our own writes (read-own-writes within
 *    the tx scope).
 *
 * The postgres unit test already proves the isolation-level mapping
 * for each dialect in isolation; this file proves the *effect*.
 */

import { CapabilityId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type Backend,
  createPostgresBackend,
  createSqliteBackend,
  SKIP_POSTGRES,
} from "./backends";

const WORKSPACE = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const DOC = DocId("018f0000-0000-7000-8000-0000000000d1");

function seedDocRow(id: DocId, workspace_id: WorkspaceId, created_by: UserId) {
  return {
    id,
    workspace_id,
    collection_id: null,
    title: "doc",
    slug: id,
    order_key: "a0",
    access_mode: "space" as const,
    published_slug: null,
    published_at: null,
    render_version: 0,
    created_by,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

function seedAuditRow(workspace_id: WorkspaceId, principal_id: UserId, capability: string) {
  return {
    id: `aud-${Math.random().toString(36).slice(2, 12)}`,
    workspace_id,
    capability_id: CapabilityId(capability),
    category: "mutation" as const,
    principal_kind: "user" as const,
    principal_id,
    acting_as_user_id: null,
    session_id: null,
    token_id: null,
    subject_kind: "doc" as const,
    subject_id: null,
    outcome: "allow" as const,
    deny_reason: null,
    input_hash: "sha256:0".padEnd(71, "0"),
    effect: "{}",
    duration_ms: 0,
    trace_id: null,
    created_at: 1,
    collapsed_count: 1,
  };
}

const backends: Array<{ name: "sqlite" | "postgres"; setup: () => Promise<Backend> }> = [
  { name: "sqlite", setup: createSqliteBackend },
];
if (!SKIP_POSTGRES) {
  backends.push({
    name: "postgres",
    setup: async () => (await createPostgresBackend()).backend,
  });
}

describe.each(backends)("withSystemTx — $name", ({ setup }) => {
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

  it("commits multi-table mutations atomically when the body resolves", async () => {
    await backend.driver.withSystemTx(async (tx) => {
      await tx
        .insertInto("docs")
        .values(seedDocRow(DOC, WORKSPACE, ALICE))
        .execute();
      await tx
        .insertInto("audit_events")
        .values(seedAuditRow(WORKSPACE, ALICE, "doc.create"))
        .execute();
    });

    const docs = await backend.driver.system().selectFrom("docs").select("id").execute();
    const audits = await backend.driver.system().selectFrom("audit_events").select("id").execute();

    expect(docs).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("rolls back every mutation when the body throws", async () => {
    await expect(
      backend.driver.withSystemTx(async (tx) => {
        await tx
          .insertInto("docs")
          .values(seedDocRow(DOC, WORKSPACE, ALICE))
          .execute();
        await tx
          .insertInto("audit_events")
          .values(seedAuditRow(WORKSPACE, ALICE, "doc.create"))
          .execute();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const docs = await backend.driver.system().selectFrom("docs").select("id").execute();
    const audits = await backend.driver.system().selectFrom("audit_events").select("id").execute();

    expect(docs).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("reads inside the tx see this tx's own writes (read-own-writes)", async () => {
    const observed = await backend.driver.withSystemTx(async (tx) => {
      await tx
        .insertInto("docs")
        .values(seedDocRow(DOC, WORKSPACE, ALICE))
        .execute();
      const rows = await tx.selectFrom("docs").select("id").execute();
      return rows;
    });
    expect(observed.map((r) => r.id)).toEqual([DOC]);
  });
});
