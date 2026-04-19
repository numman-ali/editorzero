/**
 * `createAuditWriter` unit tests.
 *
 * Covers the field-for-field projection from `AuditWriteInput` to
 * `audit_events` (F90), the deny-reason denormalisation, and the
 * `withSystemTx` rollback semantics that make the writer safe to
 * compose inside the dispatcher write-path tx.
 */

import type { AuditWriteInput } from "@editorzero/audit";
import { AgentId, CapabilityId, DocId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asAuditTx, createAuditWriter } from "./audit-writer";
import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { AUDIT_EVENTS_DDL, OUTBOX_DDL } from "./drivers/sqlite-ddl";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const AGENT_ID = AgentId("018f0000-0000-7000-8000-0000000000aa");
const TOKEN_ID = TokenId("018f0000-0000-7000-8000-0000000000bb");
const DOC_ID = DocId("018f0000-0000-7000-8000-0000000000c1");
const DOC_CREATE = CapabilityId("doc.create");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(AUDIT_EVENTS_DDL);
  driver.exec(OUTBOX_DDL);
});

afterEach(async () => {
  await driver.close();
});

function allowInput(): AuditWriteInput {
  return {
    workspace_id: WORKSPACE_ID,
    capability_id: DOC_CREATE,
    category: "mutation",
    principal_kind: "user",
    principal_id: USER_ID,
    acting_as_user_id: null,
    session_id: "sess-1",
    token_id: null,
    subject_kind: "doc",
    subject_id: DOC_ID,
    input_hash: "0".repeat(64),
    duration_ms: 7,
    trace_id: "trace-1",
    collapsed_count: 1,
    record: {
      outcome: "allow",
      effect: { kind: "audit.access_log" },
    },
  };
}

describe("createAuditWriter", () => {
  it("inserts a row with every AuditWriteInput field projected to the right column", async () => {
    const writer = createAuditWriter(() => 123_456);
    await driver.withSystemTx((tx) => writer.write(asAuditTx(tx), allowInput()));

    const rows = await driver.system().selectFrom("audit_events").selectAll().execute();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error("expected one row");
    expect(row.workspace_id).toBe(WORKSPACE_ID);
    expect(row.capability_id).toBe(DOC_CREATE);
    expect(row.category).toBe("mutation");
    expect(row.principal_kind).toBe("user");
    expect(row.principal_id).toBe(USER_ID);
    expect(row.session_id).toBe("sess-1");
    expect(row.subject_kind).toBe("doc");
    expect(row.subject_id).toBe(DOC_ID);
    expect(row.input_hash).toBe("0".repeat(64));
    expect(row.duration_ms).toBe(7);
    expect(row.trace_id).toBe("trace-1");
    expect(row.collapsed_count).toBe(1);
    expect(row.outcome).toBe("allow");
    expect(row.deny_reason).toBeNull();
    // `effect` is TEXT-JSON; round-trip to verify the writer serialised
    // the `AuditEffect` union faithfully.
    expect(JSON.parse(row.effect)).toEqual({ kind: "audit.access_log" });
    expect(row.created_at).toBe(123_456);
  });

  it("deny rows denormalise deny_reason from record.effect.reason_code", async () => {
    const writer = createAuditWriter();
    await driver.withSystemTx((tx) =>
      writer.write(asAuditTx(tx), {
        ...allowInput(),
        record: {
          outcome: "deny",
          reason: {
            kind: "missing_scope",
            required: ["admin"],
            principal_scopes: [],
          },
          effect: {
            kind: "deny",
            capability: DOC_CREATE,
            required_scopes: ["workspace:admin"],
            reason_code: "missing_scope",
          },
        },
      }),
    );

    const rows = await driver.system().selectFrom("audit_events").selectAll().execute();
    expect(rows[0]?.outcome).toBe("deny");
    expect(rows[0]?.deny_reason).toBe("missing_scope");
  });

  it("agent principal projects token_id + acting_as_user_id on the row", async () => {
    const writer = createAuditWriter();
    await driver.withSystemTx((tx) =>
      writer.write(asAuditTx(tx), {
        ...allowInput(),
        principal_kind: "agent",
        principal_id: AGENT_ID,
        token_id: TOKEN_ID,
        acting_as_user_id: USER_ID,
        session_id: null,
      }),
    );

    const rows = await driver.system().selectFrom("audit_events").selectAll().execute();
    expect(rows[0]?.principal_kind).toBe("agent");
    expect(rows[0]?.principal_id).toBe(AGENT_ID);
    expect(rows[0]?.token_id).toBe(TOKEN_ID);
    expect(rows[0]?.acting_as_user_id).toBe(USER_ID);
    expect(rows[0]?.session_id).toBeNull();
  });

  it("rolls back the audit row when the enclosing withSystemTx rejects", async () => {
    const writer = createAuditWriter();
    await expect(
      driver.withSystemTx(async (tx) => {
        await writer.write(asAuditTx(tx), allowInput());
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const rows = await driver.system().selectFrom("audit_events").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it("defaults created_at to Date.now when no clock is injected", async () => {
    const before = Date.now();
    const writer = createAuditWriter();
    await driver.withSystemTx((tx) => writer.write(asAuditTx(tx), allowInput()));
    const after = Date.now();

    const rows = await driver.system().selectFrom("audit_events").selectAll().execute();
    const created = rows[0]?.created_at ?? 0;
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
  });

  it("populates a UUIDv7 id per row (time-sortable; §3.1)", async () => {
    // UUIDv7 specifically — not v4 — because `(created_at, id)` keyset
    // pagination over `audit_events` is only deterministic when the id
    // shares the time-prefix ordering with `created_at`. v4 would
    // randomise rows that land in the same millisecond.
    const writer = createAuditWriter();
    await driver.withSystemTx((tx) => writer.write(asAuditTx(tx), allowInput()));
    await driver.withSystemTx((tx) => writer.write(asAuditTx(tx), allowInput()));
    const rows = await driver.system().selectFrom("audit_events").selectAll().execute();
    expect(rows).toHaveLength(2);
    const v7Re = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(rows[0]?.id).toMatch(v7Re);
    expect(rows[1]?.id).toMatch(v7Re);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it("emits outbox(audit.appended) in the same tx with audit_id + capability + outcome + category", async () => {
    // Architecture.md §6.2/§6.3 contract: every `audit_events` INSERT
    // pairs with a transactional-outbox row so the webhook/projection
    // pollers can fan out at-least-once. Missing this emission would
    // break invariant 3 (audit trail reconstruction) for any downstream
    // consumer that reads the log via outbox.
    const writer = createAuditWriter(() => 123_456);
    await driver.withSystemTx((tx) => writer.write(asAuditTx(tx), allowInput()));

    const auditRows = await driver.system().selectFrom("audit_events").selectAll().execute();
    expect(auditRows).toHaveLength(1);
    const auditId = auditRows[0]?.id;
    if (auditId === undefined) throw new Error("expected audit row id");

    const outbox = await driver.system().selectFrom("outbox").selectAll().execute();
    expect(outbox).toHaveLength(1);
    const row = outbox[0];
    if (row === undefined) throw new Error("expected outbox row");
    expect(row.event).toBe("audit.appended");
    expect(row.workspace_id).toBe(WORKSPACE_ID);
    expect(row.created_at).toBe(123_456);
    expect(row.forwarded_at).toBeNull();
    expect(row.forwarded_to).toBeNull();
    // Payload is canonical JSON keyed on audit_id so downstream
    // consumers can re-fetch the full row; capability + outcome +
    // category give the poller enough to compose webhook event keys
    // without the extra round-trip.
    expect(JSON.parse(row.payload)).toEqual({
      audit_id: auditId,
      capability_id: DOC_CREATE,
      outcome: "allow",
      category: "mutation",
    });
  });

  it("outbox(audit.appended) rolls back when the enclosing tx rejects", async () => {
    const writer = createAuditWriter();
    await expect(
      driver.withSystemTx(async (tx) => {
        await writer.write(asAuditTx(tx), allowInput());
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    // Both rows live in the same tx; the outbox fan-out must not
    // survive a rollback of the audit row it describes.
    expect(await driver.system().selectFrom("audit_events").selectAll().execute()).toHaveLength(0);
    expect(await driver.system().selectFrom("outbox").selectAll().execute()).toHaveLength(0);
  });

  it("outbox(audit.appended) payload reflects the outcome for deny rows", async () => {
    // Webhook subscribers route on the outcome (e.g. `audit.appended.doc.*`
    // filtered to `outcome=deny` for security alerting). The payload must
    // stay truthful about what actually happened.
    const writer = createAuditWriter();
    await driver.withSystemTx((tx) =>
      writer.write(asAuditTx(tx), {
        ...allowInput(),
        record: {
          outcome: "deny",
          reason: { kind: "missing_scope", required: ["admin"], principal_scopes: [] },
          effect: {
            kind: "deny",
            capability: DOC_CREATE,
            required_scopes: ["workspace:admin"],
            reason_code: "missing_scope",
          },
        },
      }),
    );

    const outbox = await driver.system().selectFrom("outbox").selectAll().execute();
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0]?.payload ?? "")).toMatchObject({
      capability_id: DOC_CREATE,
      outcome: "deny",
      category: "mutation",
    });
  });

  it("deny_reason tracks effect.reason_code, not the internal reason.kind", async () => {
    // A capability's `effectOnDeny` can map its internal `DenyReason.kind`
    // to a custom `reason_code` in the `AuditDeny` envelope (e.g. surface
    // a `"rate_limited"` public code while the internal taxonomy says
    // `"missing_scope"`). The indexed `deny_reason` column has to mirror
    // the public effect, or analytic queries and the JSON payload will
    // silently disagree.
    const writer = createAuditWriter();
    await driver.withSystemTx((tx) =>
      writer.write(asAuditTx(tx), {
        ...allowInput(),
        record: {
          outcome: "deny",
          reason: {
            kind: "missing_scope",
            required: ["admin"],
            principal_scopes: [],
          },
          effect: {
            kind: "deny",
            capability: DOC_CREATE,
            required_scopes: ["workspace:admin"],
            reason_code: "rate_limited",
          },
        },
      }),
    );

    const rows = await driver.system().selectFrom("audit_events").selectAll().execute();
    expect(rows[0]?.deny_reason).toBe("rate_limited");
    expect(rows[0]?.deny_reason).not.toBe("missing_scope");
  });
});
