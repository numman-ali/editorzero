/**
 * Metadata-only atomicity — crash-fuzz property test (§17.1 row 7b,
 * closes Appendix C item 16).
 *
 * Sibling of `packages/dispatcher/prop/writepath-atomicity.test.ts`
 * (F31, content-mutation fuzz). This suite fuzzes the metadata-only
 * write path (`METADATA_ONLY_CAPABILITIES` in `@editorzero/scopes`) —
 * the capabilities that mutate relational state without a
 * `doc_updates` pair and therefore sit outside the F31 five-row tuple.
 *
 * **Property under test.** For every metadata-only mutation dispatch,
 * the four-row commit (architecture.md §6.5, ADR 0018 F10/F31) is
 * all-or-none:
 *
 *   1. `docs` row (UPDATE — visibility + visibility_version + updated_at).
 *   2. `audit_events(outcome='allow')` — dispatcher via `createAuditWriter`.
 *   3. `outbox(event='audit.appended')` — paired with (2), same writer.
 *   4. `outbox(event='doc.visibility_changed')` — queued during the
 *      handler's `ctx.outbox(...)` call and flushed by the trunk
 *      composition root (`createApiDispatcher`) via
 *      `createOutboxWriter().append(auditTx, …)` before `withSystemTx`
 *      commits.
 *
 * If a fault fires at ANY query inside the write-path tx, all four
 * rows are absent afterwards. If no fault triggers, all four land.
 * There is no middle ground — "some rows committed, others didn't"
 * would break invariant 3 (architecture.md § Hard invariants) for a
 * metadata-only mutation, which is the exact gap ADR 0018 § Out of
 * scope called out and Appendix C item 16 tracked.
 *
 * **Real factory, wrapped driver.** This fixture exercises the actual
 * `createApiDispatcher` by layering the fault-injecting Kysely plugin
 * inside a thin driver wrapper — `withSystemTx(fn)` delegates to the
 * real driver but calls `fn(rawTx.withPlugin(plugin))` on the way in.
 * So the factory's write-path wiring (queue-and-flush for handler-
 * emitted outbox, `asAuditTx` conversion, single-tx commit boundary)
 * is exercised directly; a drift in `createApiDispatcher.ts` cannot
 * keep this suite green.
 *
 * **Capability fixture.** The real `doc.publish` — exercises the seam
 * end-to-end with a genuine `ctx.outbox(...)` emission the handler
 * owns (not a synthetic fixture). Every metadata-only capability
 * (`doc.unpublish`, `doc.delete`, `doc.restore`, `doc.move`,
 * `block.set_visibility`, `collection.*`) runs the same queue-and-
 * flush primitive and is therefore covered by the same property; the
 * per-capability behaviour (404 on soft-deleted, input validation,
 * etc.) is covered by the capability's own unit tests.
 *
 * **Fault injection.** A Kysely plugin's `transformQuery` counts
 * queries and throws at a target ordinal. The plugin is attached via
 * the driver wrapper, and the `FaultController` self-disarms on
 * trigger so the dispatcher's subsequent error-audit `withAuditTx`
 * (a separate tx opened after the rollback) is not fault-injected —
 * that tx is the observability contract (error audits survive the
 * rollback) and is not part of the atomicity target under test.
 *
 * **Scope limitations.**
 *   1. Fault injection is pre-execute (Kysely `transformQuery` short-
 *      circuits before the driver sees the query). The tx primitive
 *      treats a pre-execute throw identically to any in-tx rejection —
 *      same `withSystemTx` catch, same `ROLLBACK` SQL — so the
 *      rollback code is exercised on every ordinal. Commit-time
 *      failures (disk full during `COMMIT`, WAL corruption) are
 *      handled by SQLite's auto-rollback per its atomicity spec and
 *      are upstream-tested; they're out of scope for an application-
 *      layer property suite.
 *   2. Single capability (`doc.publish`). Every metadata-only
 *      capability runs through the same queue-and-flush primitive;
 *      per-capability write shapes are covered by the capability unit
 *      tests. Adding more capabilities to this fuzz would multiply the
 *      runtime without a proportional invariant gain — the atomicity
 *      property is about the primitive, not the capability shape.
 */

import { createRegistry, docPublish, registerCapability } from "@editorzero/capabilities";
import {
  createOutboxWriter,
  createQueryFaultPlugin,
  createSqliteDriver,
  type QueryTag,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { DocId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AccessPath, UserPrincipal } from "@editorzero/principal";
import { describe, expect, it } from "vitest";

import { createApiDispatcher } from "../src/composition/createApiDispatcher";

// ── Shared constants ─────────────────────────────────────────────────────

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_ID = DocId("018f0000-0000-7000-8000-0000000000a1");

function testUser(): UserPrincipal {
  return {
    kind: "user",
    id: USER_ID,
    workspace_id: WORKSPACE_ID,
    // `doc:publish` is admin-only per `ROLE_SCOPES` in
    // `packages/dispatcher/src/gate.ts` (member / guest don't carry
    // it — the scope-matrix split at the `editor` agent tier mirrors
    // this). A fixture user that needs to successfully dispatch
    // `doc.publish` must land on the admin role.
    roles: ["admin"],
    session_id: null,
    token_id: null,
  };
}

function testAccess(): AccessPath {
  return { workspace_id: WORKSPACE_ID };
}

// ── Fault injection ──────────────────────────────────────────────────────

class FaultInjectedError extends Error {
  constructor(readonly ordinal: number) {
    super(`fault-injected at tx query #${ordinal}`);
    this.name = "FaultInjectedError";
  }
}

/**
 * Controller for the fault-injecting Kysely plugin. The plugin's
 * `transformQuery` callback fires `hit(tag)` for every in-tx query; on
 * the armed ordinal `hit` throws and self-disarms so the dispatcher's
 * subsequent `withAuditTx` (a separate tx opened after rollback to
 * record the error audit) runs without fault injection. That second
 * tx is observability, not atomicity — error audits must survive the
 * rollback that the fault itself caused.
 */
class FaultController {
  #callCount = 0;
  #active = false;
  #faultOrdinal: number | null = null;
  #triggered = false;
  #tags: QueryTag[] = [];

  arm(ordinal: number): void {
    this.#callCount = 0;
    this.#active = true;
    this.#faultOrdinal = ordinal;
    this.#triggered = false;
    this.#tags = [];
  }

  wasTriggered(): boolean {
    return this.#triggered;
  }

  callsIssued(): number {
    return this.#callCount;
  }

  tagsCaptured(): readonly QueryTag[] {
    return this.#tags;
  }

  hit(tag: QueryTag): void {
    if (!this.#active) return;
    this.#callCount += 1;
    this.#tags.push(tag);
    if (this.#callCount === this.#faultOrdinal) {
      this.#triggered = true;
      // Self-disarm so the dispatcher's post-rollback
      // `withAuditTx` runs unfaulted — the error-audit row is the
      // observability contract and must survive.
      this.#active = false;
      throw new FaultInjectedError(this.#callCount);
    }
  }
}

// ── Driver wrapper ──────────────────────────────────────────────────────

/**
 * Wraps a `SqliteDriver` so every `withSystemTx(fn)` call passes the
 * plugin-equipped tx into `fn`. Everything else on the driver surface
 * (`scoped`, `system`, `close`, `exec`, `pragma`) is forwarded to the
 * real driver unchanged. The `FaultController` handles per-tx
 * arm/trigger/disarm semantics — this wrapper doesn't touch it.
 */
function wrapDriverWithPlugin(
  real: SqliteDriver,
  plugin: ReturnType<typeof createQueryFaultPlugin>,
): SqliteDriver {
  return {
    scoped: (workspace_id) => real.scoped(workspace_id),
    system: () => real.system(),
    withSystemTx: (fn) => real.withSystemTx((rawTx) => fn(rawTx.withPlugin(plugin))),
    close: () => real.close(),
    exec: (sql) => real.exec(sql),
    pragma: (name) => real.pragma(name),
  };
}

// ── Per-trial fixture ────────────────────────────────────────────────────

async function seedDoc(driver: SqliteDriver): Promise<void> {
  // Seed a workspace-visibility doc. `doc.publish` will flip it to
  // `public` and bump `visibility_version` from 0 → 1. The reject-arm
  // assertions below pivot on the seed values ("workspace", 0) to
  // prove the rollback restored pre-dispatch state.
  await driver
    .system()
    .insertInto("docs")
    .values({
      id: DOC_ID,
      workspace_id: WORKSPACE_ID,
      collection_id: null,
      title: "seed",
      slug: "seed",
      order_key: "a",
      visibility: "workspace",
      visibility_version: 0,
      created_by: USER_ID,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .execute();
}

interface TrialResult {
  readonly thrown: unknown;
  readonly faultTriggered: boolean;
  readonly callsIssued: number;
  readonly tags: readonly QueryTag[];
  readonly docVisibility: "workspace" | "public" | "private";
  readonly docVisibilityVersion: number;
  readonly visibilityChangedOutboxCount: number;
  readonly auditAppendedOutboxCount: number;
  readonly allowAuditCount: number;
  readonly errorAuditCount: number;
}

async function runTrial(faultOrdinal: number): Promise<TrialResult> {
  const realDriver = createSqliteDriver({ path: ":memory:" });
  realDriver.exec(SQLITE_FULL_DDL);
  const fault = new FaultController();
  const plugin = createQueryFaultPlugin((tag) => fault.hit(tag));
  const driver = wrapDriverWithPlugin(realDriver, plugin);

  try {
    await seedDoc(realDriver);

    const registry = createRegistry([registerCapability(docPublish)]);
    let tick = 0;

    // Real trunk factory. The only injected test scaffolding is the
    // driver wrapper (plugin layering) and a deterministic `now`;
    // everything else — `createAuditWriter`, `createOutboxWriter`,
    // the queue-and-flush logic, the read-path `ctx.outbox` throw —
    // comes from the production composition.
    const dispatcher = createApiDispatcher({
      driver,
      registry,
      outboxWriter: createOutboxWriter(() => {
        tick += 1;
        return tick;
      }),
      now: () => {
        tick += 1;
        return tick;
      },
    });

    // Arm once before dispatch. The fault self-disarms on trigger, so
    // the dispatcher's error-audit `withAuditTx` (which runs after the
    // write-path rollback) sees the plugin attached but the controller
    // inert — its queries pass through unfaulted.
    fault.arm(faultOrdinal);

    let thrown: unknown = null;
    try {
      await dispatcher.dispatch({
        capability_id: docPublish.id,
        input: { doc_id: DOC_ID },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      });
    } catch (err) {
      thrown = err;
    }

    const docRow = await realDriver
      .system()
      .selectFrom("docs")
      .select(["visibility", "visibility_version"])
      .where("id", "=", DOC_ID)
      .executeTakeFirstOrThrow();
    const outboxRows = await realDriver.system().selectFrom("outbox").select("event").execute();
    const visibilityChangedOutboxCount = outboxRows.filter(
      (r) => r.event === "doc.visibility_changed",
    ).length;
    const auditAppendedOutboxCount = outboxRows.filter((r) => r.event === "audit.appended").length;
    const auditRows = await realDriver
      .system()
      .selectFrom("audit_events")
      .select("outcome")
      .execute();
    const allowAuditCount = auditRows.filter((r) => r.outcome === "allow").length;
    const errorAuditCount = auditRows.filter((r) => r.outcome === "error").length;

    return {
      thrown,
      faultTriggered: fault.wasTriggered(),
      callsIssued: fault.callsIssued(),
      tags: fault.tagsCaptured(),
      docVisibility: docRow.visibility,
      docVisibilityVersion: docRow.visibility_version,
      visibilityChangedOutboxCount,
      auditAppendedOutboxCount,
      allowAuditCount,
      errorAuditCount,
    };
  } finally {
    await realDriver.close();
  }
}

function countInserts(tags: readonly QueryTag[], table: string): number {
  return tags.filter((t) => t.kind === "InsertQueryNode" && t.table === table).length;
}

function countUpdates(tags: readonly QueryTag[], table: string): number {
  return tags.filter((t) => t.kind === "UpdateQueryNode" && t.table === table).length;
}

function countOutboxInserts(tags: readonly QueryTag[], event: string): number {
  return tags.filter(
    (t) => t.kind === "InsertQueryNode" && t.table === "outbox" && t.event === event,
  ).length;
}

// ── Properties ────────────────────────────────────────────────────────────
//
// One suite (cold vs warm is a content-mutation concern — metadata-only
// has no Y.Doc hydration, no `doc_counters` bootstrap, so first and Nth
// calls share the same query shape). Baseline pins the exact query
// count + per-table tag breakdown; iteration loop fuzzes every ordinal.

/**
 * Expected query count inside the metadata-only write-path tx.
 * Empirically observed breakdown (4 queries):
 *
 *   1 — handler `UPDATE docs` (doc.publish: visibility + visibility_version
 *       + updated_at, single statement with RETURNING)
 * + 1 — `createAuditWriter` `INSERT audit_events` (dispatcher's allow audit,
 *       called inside `fn` before it returns)
 * + 1 — `createAuditWriter` `INSERT outbox(audit.appended)` (paired
 *       with the audit row, same writer)
 * + 1 — `createOutboxWriter` `INSERT outbox(doc.visibility_changed)`
 *       (flushed from the handler's queued `ctx.outbox(...)` call
 *       after `fn` returns, before `withSystemTx` commits)
 *
 * `MAX_ORDINAL` is chosen above `EXPECTED_META_TX_QUERIES` so the
 * iteration loop's no-op arm (ordinal > last in-tx query) covers the
 * "fault past the tail" case explicitly.
 */
const EXPECTED_META_TX_QUERIES = 4;
const MAX_ORDINAL = 8;

describe("metadata-only atomicity (§17.1 row 7b)", () => {
  it("baseline: happy-path metadata-only tx issues the expected shape of queries", async () => {
    const result = await runTrial(10_000);
    expect(result.thrown).toBeNull();
    expect(result.faultTriggered).toBe(false);
    // Four-row commit landed.
    expect(result.docVisibility).toBe("public");
    expect(result.docVisibilityVersion).toBe(1);
    expect(result.allowAuditCount).toBe(1);
    expect(result.auditAppendedOutboxCount).toBe(1);
    expect(result.visibilityChangedOutboxCount).toBe(1);
    expect(result.errorAuditCount).toBe(0);
    // Exact query count — ranges would leave a blind spot where a
    // query migrates across the tx boundary while another moves in.
    expect(result.callsIssued).toBe(EXPECTED_META_TX_QUERIES);
    // Per-table tag breakdown — proves the specific writes ran inside
    // the plugin-wrapped tx. If a regression moves the handler's UPDATE
    // outside the tx and a different UPDATE moves in, `callsIssued`
    // stays at 4 but `countUpdates(..., "docs")` flips.
    expect(countUpdates(result.tags, "docs")).toBe(1);
    expect(countInserts(result.tags, "audit_events")).toBe(1);
    expect(countOutboxInserts(result.tags, "audit.appended")).toBe(1);
    expect(countOutboxInserts(result.tags, "doc.visibility_changed")).toBe(1);
    expect(MAX_ORDINAL).toBeGreaterThanOrEqual(EXPECTED_META_TX_QUERIES);
  });

  for (let ordinal = 1; ordinal <= MAX_ORDINAL; ordinal++) {
    it(`fault at ordinal ${ordinal}: four-row commit is all-or-none`, async () => {
      const result = await runTrial(ordinal);

      if (result.thrown !== null) {
        // Reject arm. The surfaced error must be the injected
        // `FaultInjectedError` at this exact ordinal — any other error
        // type or ordinal means rejection came from elsewhere (e.g., a
        // broken rollback path) and the atomicity claims would be
        // testing the wrong failure mode.
        expect(result.thrown).toBeInstanceOf(FaultInjectedError);
        expect((result.thrown as FaultInjectedError).ordinal).toBe(ordinal);
        expect(result.faultTriggered).toBe(true);
        // Every row inside the write-path tx is absent. The docs
        // UPDATE rolled back to the seed (workspace / 0); the audit
        // allow row + its outbox(audit.appended) pair + the handler-
        // emitted outbox(doc.visibility_changed) are all gone.
        expect(result.docVisibility).toBe("workspace");
        expect(result.docVisibilityVersion).toBe(0);
        expect(result.allowAuditCount).toBe(0);
        expect(result.visibilityChangedOutboxCount).toBe(0);
        // The error-audit row lands in the separate `withAuditTx` and
        // commits independently — observability survives the rollback.
        // That tx writes its own `audit_events(error)` row AND its own
        // paired `outbox(audit.appended)` row, so
        // `auditAppendedOutboxCount === 1` on the reject arm (from the
        // error-audit path) and the write-path tx contributed zero.
        expect(result.errorAuditCount).toBe(1);
        expect(result.auditAppendedOutboxCount).toBe(1);
      } else {
        // No-op arm — the fault was past the last in-tx query so the
        // dispatch resolved and all four rows committed.
        expect(result.faultTriggered).toBe(false);
        expect(result.docVisibility).toBe("public");
        expect(result.docVisibilityVersion).toBe(1);
        expect(result.allowAuditCount).toBe(1);
        expect(result.auditAppendedOutboxCount).toBe(1);
        expect(result.visibilityChangedOutboxCount).toBe(1);
        expect(result.errorAuditCount).toBe(0);
      }
    });
  }
});
