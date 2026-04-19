/**
 * Writers conformance across SQLite + Postgres (ADR 0023 §4 /
 * architecture.md §6.1 + §6.2).
 *
 * `createAuditWriter` and `createDocUpdatesWriter` are implemented
 * entirely on top of Kysely — no raw SQL, no dialect-specific calls.
 * The question this test answers is empirical: does the writer
 * actually run end-to-end against a real Postgres, including the
 * ON CONFLICT DO NOTHING bootstrap on `doc_counters`, the composite-
 * FK-covered `doc_updates` INSERT, and the twin `outbox` fan-outs
 * (`audit.appended` + `doc.updated`)?
 *
 * If any future change accidentally leaks a dialect-specific
 * construct into one of these writers (e.g. SQLite's `INSERT OR
 * IGNORE` instead of the Kysely `onConflict` builder), this harness
 * surfaces the regression at commit time rather than at production
 * Postgres boot time.
 *
 * Scope is deliberately tight — the same `withSystemTx`-atomicity +
 * tenant-isolation invariants are already covered by the neighbouring
 * integration tests. This file only asserts: writer runs, writer
 * lands the row, paired outbox row is emitted. The SQL-level
 * ordering (bootstrap → SELECT → UPDATE → INSERT → outbox) is the
 * unit test's job (`doc-updates-writer.unit.test.ts`) — we don't
 * re-prove that here.
 */

import type { AuditRecord } from "@editorzero/audit";
import { CapabilityId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asAuditTx, createAuditWriter } from "../../src/audit-writer";
import { createDocUpdatesReader } from "../../src/doc-updates-reader";
import { createDocUpdatesWriter } from "../../src/doc-updates-writer";
import {
  type Backend,
  createPostgresBackend,
  createSqliteBackend,
  SKIP_POSTGRES,
} from "./backends";

const WORKSPACE = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const DOC = DocId("018f0000-0000-7000-8000-0000000000d1");

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

const ALLOW_READ: AuditRecord = {
  outcome: "allow",
  effect: { kind: "audit.access_log" },
};

const PRINCIPAL_ALICE: Principal = {
  kind: "user",
  id: ALICE,
  workspace_id: WORKSPACE,
  roles: [],
  session_id: null,
  token_id: null,
};

const backends: Array<{ name: "sqlite" | "postgres"; setup: () => Promise<Backend> }> = [
  { name: "sqlite", setup: createSqliteBackend },
];
if (!SKIP_POSTGRES) {
  backends.push({
    name: "postgres",
    setup: async () => (await createPostgresBackend()).backend,
  });
}

describe.each(backends)("writers conformance — $name", ({ setup }) => {
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

  it("createAuditWriter inserts audit_events + outbox(audit.appended) atomically", async () => {
    const writer = createAuditWriter(() => 1_700_000_000_000);

    await backend.driver.withSystemTx(async (tx) => {
      await writer.write(asAuditTx(tx), {
        workspace_id: WORKSPACE,
        capability_id: CapabilityId("doc.list"),
        category: "read",
        principal_kind: "user",
        principal_id: ALICE,
        acting_as_user_id: null,
        session_id: null,
        token_id: null,
        subject_kind: "workspace",
        subject_id: null,
        input_hash: "0".repeat(64),
        duration_ms: 1,
        trace_id: null,
        collapsed_count: 1,
        record: ALLOW_READ,
      });
    });

    const audits = await backend.driver
      .system()
      .selectFrom("audit_events")
      .select(["capability_id", "outcome", "category", "workspace_id"])
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.capability_id).toBe("doc.list");
    expect(audits[0]?.outcome).toBe("allow");

    const outboxRows = await backend.driver
      .system()
      .selectFrom("outbox")
      .select(["event", "workspace_id"])
      .execute();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.event).toBe("audit.appended");
  });

  it("createDocUpdatesWriter bootstraps doc_counters, allocates seq, writes doc_updates + outbox(doc.updated)", async () => {
    // `doc_counters` FK requires a parent `docs` row. Seed via unscoped
    // `system()` to sidestep the scoping plugin.
    await backend.driver
      .system()
      .insertInto("docs")
      .values(seedDoc(DOC, WORKSPACE, ALICE))
      .execute();

    const writer = createDocUpdatesWriter(() => 1_700_000_000_000);
    const blob = new Uint8Array([0x01, 0x02, 0xff]);

    const first = await backend.driver.withSystemTx(async (tx) => {
      return writer.write(asAuditTx(tx), {
        doc_id: DOC,
        workspace_id: WORKSPACE,
        update_blob: blob,
        principal: PRINCIPAL_ALICE,
      });
    });
    expect(first.seq).toBe(1);

    // Second write on the same doc should allocate seq=2, proving the
    // ON CONFLICT DO NOTHING bootstrap is a true no-op on the re-entry
    // path (not a row re-mint).
    const second = await backend.driver.withSystemTx(async (tx) => {
      return writer.write(asAuditTx(tx), {
        doc_id: DOC,
        workspace_id: WORKSPACE,
        update_blob: blob,
        principal: PRINCIPAL_ALICE,
      });
    });
    expect(second.seq).toBe(2);

    const updates = await backend.driver
      .system()
      .selectFrom("doc_updates")
      .select(["seq", "doc_id", "workspace_id"])
      .orderBy("seq", "asc")
      .execute();
    expect(updates.map((u) => u.seq)).toEqual([1, 2]);

    const counter = await backend.driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC)
      .executeTakeFirstOrThrow();
    expect(counter.next_seq).toBe(3);

    const outboxRows = await backend.driver.system().selectFrom("outbox").select("event").execute();
    expect(outboxRows.map((r) => r.event)).toEqual(["doc.updated", "doc.updated"]);
  });

  it("createDocUpdatesReader returns the writes in seq order", async () => {
    await backend.driver
      .system()
      .insertInto("docs")
      .values(seedDoc(DOC, WORKSPACE, ALICE))
      .execute();

    const writer = createDocUpdatesWriter(() => 1_700_000_000_000);
    const reader = createDocUpdatesReader();
    const blobs = [new Uint8Array([0x01]), new Uint8Array([0x02]), new Uint8Array([0x03])];
    for (const update_blob of blobs) {
      await backend.driver.withSystemTx(async (tx) => {
        await writer.write(asAuditTx(tx), {
          doc_id: DOC,
          workspace_id: WORKSPACE,
          update_blob,
          principal: PRINCIPAL_ALICE,
        });
      });
    }

    const rows = await backend.driver.withSystemTx(async (tx) =>
      reader.readByDoc(asAuditTx(tx), DOC),
    );
    // Each element is the raw update_blob per row. PG returns Buffer and
    // SQLite returns Uint8Array; both compare equal byte-wise.
    expect(rows.map((b) => Array.from(b))).toEqual([[0x01], [0x02], [0x03]]);
  });
});
