/**
 * `SqliteDocUpdatesWriter` — per-method unit tests against real SQLite.
 *
 * Locks the writer contract that `@editorzero/sync` depends on:
 *   1. Seq is allocated via SELECT + UPDATE on `doc_counters`; the
 *      `doc_updates` row carries that seq.
 *   2. An `outbox(doc.updated)` row lands in the same tx.
 *   3. First write on a doc auto-bootstraps `doc_counters` via
 *      INSERT OR IGNORE (closes Codex P3.6c adversarial P3 — the
 *      `doc.create` first-write path can't prime a counter separately).
 *   4. The FK on `doc_counters.doc_id → docs.id` surfaces missing-
 *      docs-row as an SQL error — callers must INSERT `docs` before
 *      the first `ctx.transact`.
 *   5. Successive writes on the same doc advance seq gaplessly.
 *   6. Agent principals are attributed correctly (no `session_id`).
 *   7. Rollback of the outer tx rolls back all four rows together
 *      (counter bootstrap + counter advance + doc_updates + outbox).
 *
 * These run in-process against `:memory:` SQLite, the same driver the
 * production deployment uses. No mocks.
 */

import { AgentId, DocId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAuditTx } from "./audit-writer";
import { createSqliteDocUpdatesWriter, type DocUpdatesWriter } from "./doc-updates-writer";
import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { FULL_DDL } from "./drivers/sqlite-ddl";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const AGENT_ID = AgentId("018f0000-0000-7000-8000-000000000003");
const TOKEN_ID = TokenId("018f0000-0000-7000-8000-000000000004");
const DOC_ID = DocId("018f0000-0000-7000-8000-0000000000a1");

let driver: SqliteDriver;
let writer: DocUpdatesWriter;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(FULL_DDL);
  writer = createSqliteDocUpdatesWriter(() => 1_700_000_000_000);
});

afterEach(async () => {
  await driver.close();
});

function userPrincipal(): UserPrincipal {
  return {
    kind: "user",
    id: USER_ID,
    workspace_id: WORKSPACE_ID,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function agentPrincipal(): AgentPrincipal {
  return {
    kind: "agent",
    id: AGENT_ID,
    workspace_id: WORKSPACE_ID,
    owner_user_id: USER_ID,
    scopes: ["doc:write"],
    token_id: TOKEN_ID,
    token_kind: "api-key",
  };
}

/**
 * Pre-seed only the `docs` row. The writer auto-bootstraps
 * `doc_counters` via `INSERT … ON CONFLICT DO NOTHING` on first write,
 * so tests no longer pre-seed the counter — doing so here would mask
 * a regression that re-introduced the pre-bootstrap assumption.
 */
async function seedDoc(): Promise<void> {
  const now = 1_700_000_000_000;
  await driver
    .system()
    .insertInto("docs")
    .values({
      id: DOC_ID,
      workspace_id: WORKSPACE_ID,
      collection_id: null,
      title: "t",
      slug: "t",
      order_key: "a",
      visibility: "workspace",
      visibility_version: 0,
      created_by: USER_ID,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    .execute();
}

async function writeUpdate(principal: Principal, blob: Uint8Array): Promise<{ seq: number }> {
  return driver.withSystemTx(async (tx) => {
    const { seq } = await writer.write(asAuditTx(tx), {
      doc_id: DOC_ID,
      workspace_id: WORKSPACE_ID,
      update_blob: blob,
      principal,
    });
    return { seq };
  });
}

describe("createSqliteDocUpdatesWriter.write", () => {
  it("inserts doc_updates with the allocated seq + increments doc_counters", async () => {
    await seedDoc();
    const blob = new Uint8Array([1, 2, 3, 4]);
    const { seq } = await writeUpdate(userPrincipal(), blob);
    expect(seq).toBe(1);

    const updates = await driver
      .system()
      .selectFrom("doc_updates")
      .selectAll()
      .where("doc_id", "=", DOC_ID)
      .execute();
    expect(updates).toHaveLength(1);
    const row = updates[0];
    expect(row?.seq).toBe(1);
    expect(Array.from(row?.update_blob ?? [])).toEqual([1, 2, 3, 4]);
    expect(row?.principal_kind).toBe("user");
    expect(row?.principal_id).toBe(USER_ID);
    expect(row?.session_id).toBeNull();

    const counter = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID)
      .executeTakeFirstOrThrow();
    expect(counter.next_seq).toBe(2);
  });

  it("emits an outbox(doc.updated) row with the doc_id + seq + update_id", async () => {
    await seedDoc();
    const { seq } = await writeUpdate(userPrincipal(), new Uint8Array([5]));

    const outbox = await driver.system().selectFrom("outbox").selectAll().execute();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event).toBe("doc.updated");
    const payload = JSON.parse(outbox[0]?.payload ?? "{}") as {
      doc_id: string;
      seq: number;
      update_id: string;
    };
    expect(payload.doc_id).toBe(DOC_ID);
    expect(payload.seq).toBe(seq);
    expect(payload.update_id).toMatch(/^[0-9a-f]{8}-/i);
    expect(outbox[0]?.forwarded_at).toBeNull();
  });

  it("advances seq gaplessly across successive writes on the same doc", async () => {
    await seedDoc();
    const principal = userPrincipal();
    await writeUpdate(principal, new Uint8Array([1]));
    await writeUpdate(principal, new Uint8Array([2]));
    const { seq } = await writeUpdate(principal, new Uint8Array([3]));
    expect(seq).toBe(3);

    const seqs = await driver
      .system()
      .selectFrom("doc_updates")
      .select("seq")
      .where("doc_id", "=", DOC_ID)
      .orderBy("seq", "asc")
      .execute();
    expect(seqs.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("attributes an agent principal without a session_id", async () => {
    await seedDoc();
    await writeUpdate(agentPrincipal(), new Uint8Array([9]));
    const row = await driver
      .system()
      .selectFrom("doc_updates")
      .selectAll()
      .where("doc_id", "=", DOC_ID)
      .executeTakeFirstOrThrow();
    expect(row.principal_kind).toBe("agent");
    expect(row.principal_id).toBe(AGENT_ID);
    expect(row.session_id).toBeNull();
  });

  it("auto-bootstraps doc_counters on first write (next_seq advances 1 → 2)", async () => {
    // Counter does not exist before the write. Writer must mint it at
    // seq=1, allocate, then advance — `doc.create` depends on this
    // (its `ctx.transact` seed runs before any dispatcher-level
    // counter-priming could). Codex P3.6c adversarial P3 closes here.
    await seedDoc();

    const before = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID)
      .executeTakeFirst();
    expect(before).toBeUndefined();

    const { seq } = await writeUpdate(userPrincipal(), new Uint8Array([1]));
    expect(seq).toBe(1);

    const after = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID)
      .executeTakeFirstOrThrow();
    expect(after.next_seq).toBe(2);
  });

  it("FK error surfaces when the docs row is missing (callers must insert docs first)", async () => {
    // No docs seed, no counter seed. `INSERT OR IGNORE` on doc_counters
    // hits the FK `doc_counters.doc_id REFERENCES docs(id)` and fails —
    // the writer propagates the SQL error rather than silently inventing
    // a counter for a non-existent doc.
    await expect(writeUpdate(userPrincipal(), new Uint8Array([1]))).rejects.toThrow(
      /FOREIGN KEY constraint failed/i,
    );
    const updates = await driver.system().selectFrom("doc_updates").selectAll().execute();
    expect(updates).toHaveLength(0);
    const counter = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID)
      .executeTakeFirst();
    expect(counter).toBeUndefined();
  });

  it("rollback of the outer tx discards doc_updates + outbox + counter bootstrap", async () => {
    await seedDoc();
    await expect(
      driver.withSystemTx(async (tx) => {
        await writer.write(asAuditTx(tx), {
          doc_id: DOC_ID,
          workspace_id: WORKSPACE_ID,
          update_blob: new Uint8Array([7]),
          principal: userPrincipal(),
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    const updates = await driver.system().selectFrom("doc_updates").selectAll().execute();
    expect(updates).toHaveLength(0);
    const outbox = await driver.system().selectFrom("outbox").selectAll().execute();
    expect(outbox).toHaveLength(0);
    // Auto-bootstrap happened inside the rolled-back tx; the counter
    // row should not exist post-rollback (a subsequent successful
    // write would re-bootstrap at next_seq=1).
    const counter = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID)
      .executeTakeFirst();
    expect(counter).toBeUndefined();
  });

  it("uses Date.now() when no custom clock is supplied", async () => {
    await seedDoc();
    const defaultWriter = createSqliteDocUpdatesWriter();
    const before = Date.now();
    await driver.withSystemTx(async (tx) => {
      await defaultWriter.write(asAuditTx(tx), {
        doc_id: DOC_ID,
        workspace_id: WORKSPACE_ID,
        update_blob: new Uint8Array([1]),
        principal: userPrincipal(),
      });
    });
    const after = Date.now();
    const row = await driver
      .system()
      .selectFrom("doc_updates")
      .select("created_at")
      .where("doc_id", "=", DOC_ID)
      .executeTakeFirstOrThrow();
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBeLessThanOrEqual(after);
  });
});
