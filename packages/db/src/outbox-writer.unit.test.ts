/**
 * `createOutboxWriter` unit tests.
 *
 * Covers the handler-facing outbox-append path: row shape, payload
 * JSON serialization, `now()` injection for deterministic timestamps,
 * and `withSystemTx` rollback semantics. Uses only the outbox DDL —
 * handler-emitted rows don't touch `audit_events` or `doc_updates`.
 */

import { WorkspaceId } from "@editorzero/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAuditTx } from "./audit-writer";
import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { OUTBOX_DDL } from "./drivers/sqlite-ddl";
import { createOutboxWriter } from "./outbox-writer";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(OUTBOX_DDL);
});

afterEach(async () => {
  await driver.close();
});

describe("createOutboxWriter", () => {
  it("appends a row with the input fields projected to the outbox columns", async () => {
    const writer = createOutboxWriter(() => 123_456);
    await driver.withSystemTx((tx) =>
      writer.append(asAuditTx(tx), {
        workspace_id: WORKSPACE_ID,
        event: "doc.visibility_changed",
        payload: { doc_id: "d_1", visibility: "public", visibility_version: 2 },
      }),
    );

    const rows = await driver.system().selectFrom("outbox").selectAll().execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.workspace_id).toBe(WORKSPACE_ID);
    expect(row.event).toBe("doc.visibility_changed");
    expect(row.created_at).toBe(123_456);
    expect(row.forwarded_at).toBeNull();
    expect(row.forwarded_to).toBeNull();
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBe(36);
  });

  it("JSON-serializes the payload at the column boundary", async () => {
    const writer = createOutboxWriter();
    const payload = { doc_id: "d_1", nested: { ok: true, n: 42 } };
    await driver.withSystemTx((tx) =>
      writer.append(asAuditTx(tx), {
        workspace_id: WORKSPACE_ID,
        event: "x.changed",
        payload,
      }),
    );

    const row = await driver.system().selectFrom("outbox").selectAll().executeTakeFirstOrThrow();
    expect(row.payload).toBe(JSON.stringify(payload));
    expect(JSON.parse(row.payload)).toEqual(payload);
  });

  it("surfaces non-serialisable payloads as a JSON.stringify TypeError", async () => {
    const writer = createOutboxWriter();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    await expect(
      driver.withSystemTx((tx) =>
        writer.append(asAuditTx(tx), {
          workspace_id: WORKSPACE_ID,
          event: "bad.payload",
          payload: cyclic,
        }),
      ),
    ).rejects.toThrow(TypeError);

    const rows = await driver.system().selectFrom("outbox").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("rolls back the outbox row when the enclosing tx throws after the append", async () => {
    const writer = createOutboxWriter();

    await expect(
      driver.withSystemTx(async (tx) => {
        await writer.append(asAuditTx(tx), {
          workspace_id: WORKSPACE_ID,
          event: "committed.nothing",
          payload: {},
        });
        throw new Error("simulated handler throw after outbox append");
      }),
    ).rejects.toThrow("simulated handler throw after outbox append");

    const rows = await driver.system().selectFrom("outbox").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("mints a fresh UUIDv7 per append (time-sortable ids)", async () => {
    const writer = createOutboxWriter();
    await driver.withSystemTx(async (tx) => {
      await writer.append(asAuditTx(tx), {
        workspace_id: WORKSPACE_ID,
        event: "a",
        payload: {},
      });
      await writer.append(asAuditTx(tx), {
        workspace_id: WORKSPACE_ID,
        event: "b",
        payload: {},
      });
    });

    const rows = await driver
      .system()
      .selectFrom("outbox")
      .selectAll()
      .orderBy("id", "asc")
      .execute();
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    if (first === undefined || second === undefined) throw new Error("expected two rows");
    expect(first.id).not.toBe(second.id);
    // UUIDv7 leading 48 bits are epoch-ms — same-ms appends may tie on
    // the prefix but the random suffix still differs. Both should sort
    // consistently (asc by id === asc by time).
    expect(first.event).toBe("a");
    expect(second.event).toBe("b");
  });
});
