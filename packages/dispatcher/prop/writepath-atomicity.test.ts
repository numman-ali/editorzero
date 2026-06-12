/**
 * Write-path atomicity — crash-fuzz property test (P3.6e commit 2).
 *
 * **Property under test.** For every content-mutation dispatch, the
 * five-row commit (architecture.md §6.2/§6.3, ADR 0018 F31) is
 * all-or-none:
 *
 *   1. `docs` row (UPDATE in this fixture — pre-seeded).
 *   2. `doc_updates` row — the CRDT delta blob, written by the sync
 *      package's `DocUpdatesWriter` inside the dispatcher's write-path tx.
 *   3. `outbox(doc.updated)` — paired with (2), same writer.
 *   4. `audit_events(outcome='allow')` row — dispatcher's allow audit,
 *      written through `createAuditWriter` on the same tx.
 *   5. `outbox(audit.appended)` — paired with (4), same writer.
 *
 * If a fault is injected at ANY query inside the write-path tx, every
 * one of (1)–(5) must be absent afterwards (the tx rolls back as a
 * unit). If no fault triggers, all five land. The property has no
 * middle ground — "some rows committed, others didn't" would break
 * invariant 7 (architecture.md § Hard invariants) end-to-end.
 *
 * **Fault injection.** A Kysely plugin's `transformQuery` counts
 * queries and throws at a target ordinal. The plugin is layered onto
 * the tx handle inside the test fixture's `runInWriteTx`
 * (`tx.withPlugin(faultPlugin)`) so only queries inside the write-path
 * tx are countable — the separate `withAuditTx` that emits the
 * error-audit row after rollback runs without fault injection, and its
 * `audit_events` + `outbox(audit.appended)` rows are attributed to
 * that second tx, not the rolled-back one.
 *
 * **Why Kysely plugin and not a driver wrap.** `transformQuery` runs
 * pre-execute; throwing there keeps the query from reaching SQLite.
 * The driver-wrap alternative would require duplicating
 * `createSqliteDriver`'s dialect-construction pipeline to graft a
 * fault-injecting `DatabaseConnection` between the dialect's `Driver`
 * and better-sqlite3 — more code, same guarantee. The plugin path
 * composes cleanly with the existing `WorkspaceScopingPlugin`
 * (Layer-2) and works unchanged under Kysely's `Transaction` because
 * `tx.withPlugin(...)` returns a plugin-equipped `Transaction`.
 *
 * **Coverage shape.** Two suites run the same property across the
 * two production code paths:
 *
 *   - **Cold-doc path** — fresh driver + fresh sync; first write
 *     exercises `onLoadDocument` hydration + `doc_counters` bootstrap.
 *     10 in-tx queries per dispatch (ADR 0043 added the clone's
 *     tail-read SELECT).
 *   - **Resident-doc path (warm)** — run a successful priming
 *     dispatch first so the Y.Doc stays in Hocuspocus's document map
 *     and the `doc_counters` row pre-exists; then fault the second
 *     dispatch. 9 in-tx queries (no hydration SELECT). Without this
 *     suite, any regression that only shows up on second+ mutations
 *     (next_seq leak across rollback, stale clone state from a
 *     late SQL fault, etc.) would go untested.
 *
 * Each suite iterates every ordinal in [1..MAX_ORDINAL]. Reject-arm
 * assertions confirm the surfaced error is `FaultInjectedError` at
 * the matching ordinal, check five-row SQL atomicity,
 * `doc_counters` rollback, AND in-memory residency (under ADR 0043
 * a rollback discards the staged updates — the resident was never
 * touched, so it STAYS resident with committed-only state on every
 * ordinal where the open succeeded; the pre-0043 eviction
 * expectation is inverted on purpose). The no-op arm (ordinal > last
 * in-tx query) asserts all five rows commit and the doc stays
 * resident. Each suite's baseline test pins four things at once:
 *
 *   1. `callsIssued` to an **exact** count (`EXPECTED_*_TX_QUERIES`).
 *      Ranges leave a blind spot where the allow-audit pair moves out
 *      of the write tx while unrelated queries are added elsewhere.
 *   2. Per-table INSERT counts on the captured query-tag stream.
 *      Proves the specific INSERTs (`audit_events`, `outbox`,
 *      `doc_updates`, `doc_counters`) actually ran inside the tx.
 *   3. `doc_counters.next_seq`. If counter allocation migrates out of
 *      the write tx, reject-arm assertions flip.
 *   4. `docResidentAfterTrial`. Pins Hocuspocus's debounce/unload
 *      semantics; the reject-arm residency assertions depend on this.
 *
 * **Scope limitations.** Two boundaries worth naming explicitly, per
 * adversarial review of this slice:
 *
 *   1. Fault injection is pre-execute (Kysely `transformQuery`
 *      short-circuits before the driver sees the query). The tx
 *      manager treats a pre-execute throw identically to any in-tx
 *      rejection — same `withSystemTx` catch, same `ROLLBACK` SQL —
 *      so the primitive's rollback code is exercised on every
 *      ordinal. Commit-time failures (disk-full during `COMMIT`,
 *      WAL corruption) are handled by SQLite's auto-rollback on
 *      commit-failure per its atomicity spec and are upstream-tested;
 *      they're out of scope for an application-layer property suite.
 *      If a future capability introduces retry logic or long-running
 *      work that a commit-failure could strand, a driver-layer harness
 *      becomes worth adding (P4 hardening).
 *   2. Single synthetic capability fixture (`doc.mutate_prop_fixture`).
 *      The property verifies the write-path tx *primitive* — `runInWriteTx`
 *      composed with `createDocUpdatesWriter`, `createAuditWriter`,
 *      and `HocuspocusSync` — which is capability-shape-agnostic: every
 *      mutation capability (`doc.create`, `doc.update`, `doc.rename`,
 *      future block caps) is wrapped by the same primitive. Per-capability
 *      regressions (e.g., `doc.create` re-ordering its INSERT outside
 *      the `ctx.transact` closure, a handler passing stale input to
 *      the writer) are covered by the integration tests at
 *      `packages/dispatcher/src/writepath.integration.test.ts`, which
 *      exercise the real capabilities under the four failure modes
 *      (allow / handler-throw / output-shape / post-parse-deny).
 */

import { type Capability, createRegistry, registerCapability } from "@editorzero/capabilities";
import {
  asAuditTx,
  createAuditWriter,
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createQueryFaultPlugin,
  createSqliteDriver,
  createTenantScopedDb,
  type QueryTag,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { CapabilityId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AccessPath, UserPrincipal } from "@editorzero/principal";
import { HocuspocusSync } from "@editorzero/sync";
import { describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { z } from "zod";
import type { CapabilityContextExtras } from "../src/index";
import { createDispatcher, scopeOnlyGate } from "../src/index";

// ── Shared constants ─────────────────────────────────────────────────────

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const DOC_ID = DocId("018f0000-0000-7000-8000-0000000000a1");
const DOC_MUTATE_ID = CapabilityId("doc.mutate_prop_fixture");

interface DocMutateInput {
  readonly doc_id: string;
  readonly text: string;
}
interface DocMutateOutput {
  readonly doc_id: string;
  readonly text: string;
}

function testUser(): UserPrincipal {
  return {
    kind: "user",
    id: USER_ID,
    workspace_id: WORKSPACE_ID,
    roles: ["member"],
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
 * External controller for the query-fault Kysely plugin. The fixture arms the
 * controller with a target ordinal before `runInWriteTx` fires;
 * disarms (unconditionally) in `finally` so the subsequent
 * error-audit `withAuditTx` — which runs through the same Kysely
 * instance — is not fault-injected. That second tx is an observability
 * path, not part of the atomicity target.
 *
 * Each query's `QueryTag` (kind + target table) is appended to
 * `#tags` in the order the plugin's `transformQuery` fires. The tag
 * captured at position `i` corresponds to the query whose execution
 * triggered `hit()` at call #`i+1`; if that call throws, the query's
 * SQL never reaches the driver, but the tag is still recorded.
 * Callers use `tagsCaptured()` to assert that specific INSERTs ran
 * inside the counted tx (a count-only guard misses the case where a
 * regression swaps two queries across the tx boundary while keeping
 * the total constant).
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

  disarm(): void {
    this.#active = false;
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
      throw new FaultInjectedError(this.#callCount);
    }
  }
}

// ── Capability fixture ────────────────────────────────────────────────────

/**
 * Content-mutation capability: UPDATE the pre-seeded `docs` row's
 * title, then mutate the Y.Doc through `ctx.transact`. This matches
 * the P3.6c integration test's `buildDocMutateCapability` shape so
 * the property test exercises the same five-row commit as the
 * integration tests.
 */
function docMutateCapability(): Capability<DocMutateInput, DocMutateOutput> {
  return {
    id: DOC_MUTATE_ID,
    category: "mutation",
    summary: "prop fixture: doc.mutate (docs UPDATE + ctx.transact insert)",
    input: z.object({ doc_id: z.string(), text: z.string() }),
    output: z.object({ doc_id: z.string(), text: z.string() }),
    requires: ["doc:write"],
    audit: {
      subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
      effectOnAllow: (input) => ({
        kind: "doc.rename",
        doc_id: DocId(input.doc_id),
        title: input.text,
        slug: input.text,
      }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: DOC_MUTATE_ID,
        required_scopes: ["doc:write"],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: DOC_MUTATE_ID,
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler: async (ctx, input) => {
      await ctx.db
        .updateTable("docs")
        .set({ title: input.text, updated_at: Date.now() })
        .where("id", "=", DocId(input.doc_id))
        .execute();
      await ctx.transact(DocId(input.doc_id), (editor) => {
        (editor as unknown as Y.Doc).getText("body").insert(0, input.text);
      });
      return { doc_id: input.doc_id, text: input.text };
    },
  };
}

// ── Per-trial fixture ────────────────────────────────────────────────────

interface TrialResult {
  readonly thrown: unknown;
  readonly faultTriggered: boolean;
  readonly callsIssued: number;
  readonly tags: readonly QueryTag[];
  readonly docTitle: string;
  readonly docUpdatesCount: number;
  readonly docUpdatedOutboxCount: number;
  readonly auditAppendedOutboxCount: number;
  readonly allowAuditCount: number;
  readonly errorAuditCount: number;
  /**
   * `doc_counters.next_seq` for `DOC_ID` after the trial, or `null` if
   * the row is absent. The writer INSERTs the counter row (bootstrap,
   * `next_seq=1`), then UPDATEs to `2` after allocating seq 1 for the
   * `doc_updates` INSERT — a successful cold trial therefore ends with
   * `next_seq=2`. A reject-arm cold trial ends with no row: the
   * bootstrap INSERT rolls back with the tx regardless of which
   * ordinal triggers the fault. Warm-path values are shifted by the
   * prime (success prime leaves `next_seq=2`, faulted second dispatch
   * rolls back the UPDATE so the post-prime value is preserved). See
   * Codex finding P2/bp5r5ej3w.
   */
  readonly counterNextSeq: number | null;
  /**
   * Whether the `DOC_ID` Y.Doc is still resident in the Hocuspocus
   * server's document map at the end of the trial. Under ADR 0043
   * handlers mutate a throwaway clone, so a faulted dispatch leaves
   * the resident UNTOUCHED — residency after rollback is benign by
   * construction and the probe pins the open/unload mechanics
   * instead: the doc is resident from the first successful open
   * onward (rollback does NOT evict — the pre-0043 expectation,
   * inverted), not resident when the fault preceded the open or
   * fired inside `onLoadDocument` (Hocuspocus unloads + rethrows on
   * a hydration failure). The committed-only content of that
   * resident is pinned in the sync suites (Codex M1 property in
   * `ws-attach.integration.test.ts`).
   */
  readonly docResidentAfterTrial: boolean;
}

async function seedDoc(driver: SqliteDriver): Promise<void> {
  const now = Date.now();
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
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
      created_by: USER_ID,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    .execute();
}

/**
 * One trial's configuration:
 *   - `faultOrdinal` — the query number (1-indexed) at which to throw.
 *   - `prime` — when `true`, run one successful dispatch (fault disarmed)
 *     before arming the real fault and running the target dispatch. This
 *     exercises the resident-doc path (Hocuspocus keeps the Y.Doc in
 *     memory across transacts, so the second dispatch's `onLoadDocument`
 *     never fires and the `doc_counters` row pre-exists — a different
 *     query shape than a cold first write). Without warm coverage the
 *     property test would silently ignore any regression that only
 *     surfaces on the second+ mutation (Codex P2, bpxpmkba3 finding 1).
 */
interface TrialOpts {
  readonly faultOrdinal: number;
  readonly prime?: boolean;
}

async function runTrial(opts: TrialOpts): Promise<TrialResult> {
  const { faultOrdinal, prime = false } = opts;
  const driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
  const docUpdatesWriter = createDocUpdatesWriter();
  const docUpdatesReader = createDocUpdatesReader();
  const sync = new HocuspocusSync({
    docUpdatesWriter,
    docUpdatesReader,
    systemDb: driver.system(),
  });
  const fault = new FaultController();
  // Kysely plugin routed through `@editorzero/db` to honour
  // `no-raw-kysely-outside-db`. The plugin's `transformQuery` invokes
  // `fault.hit(tag)` on every in-tx query — `tag` carries the
  // `{kind, table}` identity of the query node. When the armed
  // ordinal is reached, `hit()` throws and Kysely short-circuits the
  // query; up to that point every tag is recorded so the property
  // test's baseline can prove specific INSERTs ran inside the tx.
  const plugin = createQueryFaultPlugin((tag) => fault.hit(tag));

  try {
    await seedDoc(driver);

    const capability = docMutateCapability();
    const registry = createRegistry([registerCapability(capability)]);
    const auditWriter = createAuditWriter();
    let tick = 0;
    // `activeFaultOrdinal` drives the fault controller each dispatch.
    // During a priming dispatch (warm path), it points outside the
    // realistic ordinal range so the fault never triggers; once the
    // prime commits, we swap in the caller's target ordinal for the
    // second dispatch. The dispatcher itself sees a single `runInWriteTx`
    // closure; the variable moves the target across dispatches.
    let activeFaultOrdinal = prime ? Number.MAX_SAFE_INTEGER : faultOrdinal;
    const dispatcher = createDispatcher({
      registry,
      gate: scopeOnlyGate(),
      auditWriter,
      tracer: noopTracer,
      logger: noopLogger,
      now: () => {
        tick += 1;
        return tick;
      },
      runInWriteTx: async (principal, fn) => {
        // Arm the fault controller as the SQL tx opens. The plugin on
        // the tx handle will count every query and throw at the
        // active ordinal. `disarm()` in `finally` ensures the
        // error-audit `withAuditTx` that follows a rollback never
        // triggers a second fault — it is a distinct tx and is not
        // part of the atomicity target under test. `bound` is
        // hoisted so the post-commit `bound.commit()` (the ADR 0043
        // broadcast moment — pure in-memory apply, no SQL) runs after
        // `withSystemTx` resolves, mirroring `createApiDispatcher`.
        let bound: ReturnType<HocuspocusSync["bind"]> | undefined;
        fault.arm(activeFaultOrdinal);
        try {
          const result = await driver.withSystemTx(async (rawTx) => {
            const tx = rawTx.withPlugin(plugin);
            const auditTx = asAuditTx(tx);
            const txBound = sync.bind({
              sqlTx: auditTx,
              principal,
              workspace_id: principal.workspace_id,
            });
            bound = txBound;
            const extras: CapabilityContextExtras = {
              db: createTenantScopedDb(tx, principal.workspace_id),
              outbox: () => {
                /* handler-emitted outbox rows land in a later slice */
              },
              transact: txBound.transact.bind(txBound),
            };
            try {
              return await fn(extras, auditTx);
            } catch (err) {
              await txBound.rollback();
              throw err;
            }
          });
          if (bound !== undefined) await bound.commit();
          return result;
        } finally {
          fault.disarm();
        }
      },
      runRead: async (principal, fn) => {
        const extras: CapabilityContextExtras = {
          db: driver.scoped(principal.workspace_id),
          outbox: () => {
            /* reads do not emit */
          },
          transact: async () => {
            throw new Error("reads must not call ctx.transact");
          },
        };
        return fn(extras);
      },
      withAuditTx: (fn) => driver.withSystemTx((tx) => fn(asAuditTx(tx))),
    });

    // Warm-path priming. Runs a successful dispatch so the doc is
    // resident in Hocuspocus's document map and `doc_counters` already
    // exists before the fault-injected second dispatch fires. Any
    // regression that only shows up after the cold-doc bootstrap path
    // (e.g., next_seq leak across successive transacts, onLoadDocument
    // skipping when doc is resident, etc.) surfaces here rather than
    // going untested.
    if (prime) {
      await dispatcher.dispatch({
        capability_id: DOC_MUTATE_ID,
        input: { doc_id: DOC_ID, text: "prime" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      });
      activeFaultOrdinal = faultOrdinal;
    }

    // Capture the thrown value rather than collapsing every rejection to
    // a single boolean — the property test's reject arm needs to confirm
    // the surfaced error was the injected `FaultInjectedError`. A
    // rejection originating elsewhere (e.g., a broken rollback path
    // throwing after catching the fault) would otherwise masquerade as
    // proof of atomicity.
    let thrown: unknown = null;
    try {
      await dispatcher.dispatch({
        capability_id: DOC_MUTATE_ID,
        input: { doc_id: DOC_ID, text: "new" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      });
    } catch (err) {
      thrown = err;
    }

    const docTitle = (
      await driver
        .system()
        .selectFrom("docs")
        .select("title")
        .where("id", "=", DOC_ID)
        .executeTakeFirstOrThrow()
    ).title;
    const docUpdatesCount = Number(
      (
        await driver
          .system()
          .selectFrom("doc_updates")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("doc_id", "=", DOC_ID)
          .executeTakeFirstOrThrow()
      ).n,
    );
    const outboxRows = await driver.system().selectFrom("outbox").select("event").execute();
    const docUpdatedOutboxCount = outboxRows.filter((r) => r.event === "doc.updated").length;
    const auditAppendedOutboxCount = outboxRows.filter((r) => r.event === "audit.appended").length;
    const auditRows = await driver.system().selectFrom("audit_events").select("outcome").execute();
    const allowAuditCount = auditRows.filter((r) => r.outcome === "allow").length;
    const errorAuditCount = auditRows.filter((r) => r.outcome === "error").length;
    // `doc_counters` snapshot — see `TrialResult.counterNextSeq` docstring.
    // `selectFrom("doc_counters").executeTakeFirst()` returns `undefined`
    // when the row is absent, which we normalise to `null` so the
    // `counterNextSeq === null` reject-arm assertion is unambiguous.
    const counterRow = await driver
      .system()
      .selectFrom("doc_counters")
      .select("next_seq")
      .where("doc_id", "=", DOC_ID)
      .executeTakeFirst();
    const counterNextSeq = counterRow ? counterRow.next_seq : null;
    // In-memory residency probe — see `docResidentAfterTrial` docstring.
    // The probe fires BEFORE `sync.close()` in the `finally` below so
    // the server-side document map still reflects the trial's post-
    // dispatch state.
    const docResidentAfterTrial = sync._server_testOnly().documents.has(DOC_ID);

    return {
      thrown,
      faultTriggered: fault.wasTriggered(),
      callsIssued: fault.callsIssued(),
      tags: fault.tagsCaptured(),
      docTitle,
      docUpdatesCount,
      docUpdatedOutboxCount,
      auditAppendedOutboxCount,
      allowAuditCount,
      errorAuditCount,
      counterNextSeq,
      docResidentAfterTrial,
    };
  } finally {
    await sync.close();
    await driver.close();
  }
}

function countInserts(tags: readonly QueryTag[], table: string): number {
  return tags.filter((t) => t.kind === "InsertQueryNode" && t.table === table).length;
}

function countOutboxInserts(tags: readonly QueryTag[], event: string): number {
  return tags.filter(
    (t) => t.kind === "InsertQueryNode" && t.table === "outbox" && t.event === event,
  ).length;
}

// ── Properties ────────────────────────────────────────────────────────────
//
// Two suites, same property. The cold-doc path (default) exercises
// first-write bootstrap; the resident-doc path primes with a
// successful dispatch first and runs the fault on the second.
//
// Each suite's baseline pins four invariants:
//   (a) exact `EXPECTED_*_TX_QUERIES` count;
//   (b) per-table INSERT breakdown on the captured tag stream
//       (Codex P2, bpnm7uehs);
//   (c) `doc_counters.next_seq` (cold=2, warm=3 — prime UPDATEs 1→2,
//       faulted second UPDATEs 2→3; Codex P2, bp5r5ej3w);
//   (d) `docResidentAfterTrial` (cold=true, warm=true after prime
//       survives the fault).
//
// Each suite's iteration loop deterministically covers every ordinal
// in [1..MAX_ORDINAL] (Codex P2, b4qh5w0h8) — the reject arm
// asserts:
//   - the surfaced error is `FaultInjectedError(ordinal)` (rules out
//     rejections originating elsewhere, e.g., a broken rollback path);
//   - the counter row is absent (cold) or pinned to prime's value
//     (warm) — catches counter leaks across rollback
//     (Codex P2, bpxpmkba3 finding 2);
//   - residency matches the open/unload mechanics, NOT an eviction:
//     under ADR 0043 a rollback discards staged updates and the
//     resident survives untouched on every ordinal where the open
//     succeeded (the polluted-resident regression Codex flagged
//     against the pre-0043 substrate is structurally impossible —
//     handlers mutate a throwaway clone; committed-only content is
//     pinned in the sync suites).

/**
 * The exact number of SQL queries a happy-path content mutation
 * issues inside the write-path tx. Any refactor that shifts this
 * count must update the constant, the tag-breakdown in the baseline
 * assertion, and ADR 0018 F31 in the same commit.
 *
 * Empirically observed breakdown (10 queries):
 *
 *   1 — handler `UPDATE docs`
 * + 1 — `onLoadDocument` `SELECT doc_updates` (hydration, commit 1)
 * + 1 — clone tail `SELECT doc_updates ... seq > watermark`
 *       (ADR 0043 — the throwaway clone tops up from the tx view)
 * + 1 — `DocUpdatesWriter` `INSERT doc_counters ... ON CONFLICT DO NOTHING`
 *       (counter bootstrap)
 * + 1 — `DocUpdatesWriter` `SELECT doc_counters.next_seq`
 * + 1 — `DocUpdatesWriter` `UPDATE doc_counters SET next_seq = seq+1`
 * + 1 — `DocUpdatesWriter` `INSERT doc_updates`
 * + 1 — `DocUpdatesWriter` `INSERT outbox (doc.updated)`
 * + 1 — `SqliteAuditWriter` `INSERT audit_events`
 * + 1 — `SqliteAuditWriter` `INSERT outbox (audit.appended)`
 *
 * `MAX_ORDINAL` is chosen above `EXPECTED_WRITE_TX_QUERIES` so the
 * iteration loop's no-op arm (ordinal > last in-tx query) covers the
 * "fault past the tail" case explicitly. The baseline test asserts
 * `MAX_ORDINAL >= EXPECTED_WRITE_TX_QUERIES` so a refactor that
 * raises the tx size past the ceiling surfaces here rather than
 * silently leaving the tail untested.
 */
const EXPECTED_WRITE_TX_QUERIES = 10;
const MAX_ORDINAL = 15;

describe("write-path atomicity (P3.6e)", () => {
  it("baseline: happy-path write tx issues the expected shape of queries (scope guard)", async () => {
    const result = await runTrial({ faultOrdinal: 10_000 });
    expect(result.thrown).toBeNull();
    expect(result.faultTriggered).toBe(false);
    expect(result.docTitle).toBe("new");
    expect(result.docUpdatesCount).toBe(1);
    expect(result.docUpdatedOutboxCount).toBe(1);
    expect(result.allowAuditCount).toBe(1);
    expect(result.auditAppendedOutboxCount).toBe(1);
    // `doc_counters.next_seq` after a successful write: bootstrap set
    // it to 1, writer allocated seq 1 and UPDATEd to 2. Any refactor
    // that detaches the counter UPDATE from the write tx (e.g., a
    // background seq-generator service) would either leave next_seq=1
    // (bootstrap without allocation commit) or drop the row entirely
    // (counter moves to a different table), both of which surface here.
    expect(result.counterNextSeq).toBe(2);
    // Exact-count scope guard. See `EXPECTED_WRITE_TX_QUERIES` docstring
    // for why a range would leave a blind spot.
    expect(result.callsIssued).toBe(EXPECTED_WRITE_TX_QUERIES);
    // Tag-shape guard: counting `callsIssued` alone is insufficient.
    // If the allow-audit pair migrates out of the write tx and two
    // unrelated statements move in, the total stays constant. Asserting
    // the target-table breakdown catches that regression — the specific
    // INSERTs we care about must be visible inside the tx the plugin
    // wrapped. See Codex finding P2/bpnm7uehs.
    expect(countInserts(result.tags, "audit_events")).toBe(1);
    expect(countInserts(result.tags, "doc_updates")).toBe(1);
    expect(countInserts(result.tags, "doc_counters")).toBe(1);
    // Event-discriminated outbox checks. Counting `outbox` INSERTs
    // alone would pass if `outbox(audit.appended)` moved out of the
    // write tx and an unrelated `outbox(...)` fan-out moved in —
    // same total, different scope. Distinguishing by event closes
    // that hole (Codex P2, bkog7a2h0).
    expect(countOutboxInserts(result.tags, "doc.updated")).toBe(1);
    expect(countOutboxInserts(result.tags, "audit.appended")).toBe(1);
    // Successful write leaves the doc resident in Hocuspocus's
    // document map (debounce + unloadImmediately:false keep it warm
    // for subsequent transacts). The warm-path suite below leans on
    // this — if this flips, residency semantics have changed and
    // both suites need to update.
    expect(result.docResidentAfterTrial).toBe(true);
    // Belt-and-braces: the iteration below must span at least every
    // in-tx query so the reject arm covers the whole surface.
    expect(MAX_ORDINAL).toBeGreaterThanOrEqual(EXPECTED_WRITE_TX_QUERIES);
  });

  // Deterministic fault-ordinal iteration. Every integer in
  // [1..MAX_ORDINAL] is exercised; each either triggers a fault (reject
  // arm — dispatch throws, tx rolls back) or passes through without
  // firing (no-op arm — ordinal beyond the last in-tx query). Both
  // arms must leave the DB in an atomic state.
  for (let ordinal = 1; ordinal <= MAX_ORDINAL; ordinal++) {
    it(`fault at ordinal ${ordinal}: five-row commit is all-or-none`, async () => {
      const result = await runTrial({ faultOrdinal: ordinal });

      if (result.thrown !== null) {
        // The dispatch rejected — the surfaced error must be the
        // injected `FaultInjectedError` at this exact ordinal. Any
        // other error type or ordinal means the rejection came from
        // elsewhere (e.g., a broken rollback path throwing after the
        // fault was caught) and the reject arm's atomicity claims
        // would be testing the wrong failure mode.
        expect(result.thrown).toBeInstanceOf(FaultInjectedError);
        expect((result.thrown as FaultInjectedError).ordinal).toBe(ordinal);
        expect(result.faultTriggered).toBe(true);
        // Atomicity: every row that lives in the write-path tx is
        // absent. The docs UPDATE rolls back to the seed title;
        // doc_updates + outbox(doc.updated) + allow audit +
        // outbox(audit.appended)-from-write-tx are all gone.
        expect(result.docTitle).toBe("seed");
        expect(result.docUpdatesCount).toBe(0);
        expect(result.docUpdatedOutboxCount).toBe(0);
        expect(result.allowAuditCount).toBe(0);
        // `doc_counters` row is absent. The bootstrap INSERT (query #4)
        // mints the row mid-tx; a rollback removes it whether the fault
        // fired before, during, or after the bootstrap. If a refactor
        // moves counter allocation out of the write tx (e.g., to a
        // pre-handler priming hook), this assertion flips to
        // `next_seq=1` on faults that triggered after priming — a
        // visible regression.
        expect(result.counterNextSeq).toBeNull();
        // In-memory residency under ADR 0043: rollback does NOT evict
        // — there is nothing to evict, the aborted mutation only ever
        // lived on the throwaway clone. Ordinal 1 faults the handler's
        // docs UPDATE before `ctx.transact` opens the doc (never
        // resident); ordinal 2 faults the hydration SELECT inside
        // `onLoadDocument`, where Hocuspocus unloads + rethrows (not
        // resident). From ordinal 3 (the clone's tail SELECT) onward
        // the open succeeded and the doc STAYS resident, holding
        // committed-only state — the benign-residency property the
        // sync suites pin with sockets attached (Codex M1).
        expect(result.docResidentAfterTrial).toBe(ordinal >= 3);
        // Error audit + its outbox land in the separate `withAuditTx`;
        // they commit independently so observability survives the
        // rollback.
        expect(result.errorAuditCount).toBe(1);
        expect(result.auditAppendedOutboxCount).toBe(1);
      } else {
        // The fault was past the last in-tx query — the dispatch
        // resolved and all five rows committed.
        expect(result.faultTriggered).toBe(false);
        expect(result.docTitle).toBe("new");
        expect(result.docUpdatesCount).toBe(1);
        expect(result.docUpdatedOutboxCount).toBe(1);
        expect(result.allowAuditCount).toBe(1);
        expect(result.errorAuditCount).toBe(0);
        expect(result.auditAppendedOutboxCount).toBe(1);
        expect(result.counterNextSeq).toBe(2);
        // Successful write leaves the doc resident — see baseline.
        expect(result.docResidentAfterTrial).toBe(true);
      }
    });
  }

  // ── Resident-doc path (warm write after prime) ──────────────────────
  //
  // The cold-path suite above only exercises the first-write code
  // paths: `onLoadDocument` hydrates from the empty `doc_updates`,
  // `DocUpdatesWriter` bootstraps `doc_counters` from zero. Production
  // writes mostly run against resident docs where the Y.Doc stays in
  // Hocuspocus's document map across successive transacts and the
  // counter row pre-exists. A regression that only shows up on
  // second+ mutations (e.g., counter-row leak across rollback,
  // hydration firing when it shouldn't, a stale clone built from a
  // wrong watermark) is invisible to the cold-path suite. This suite
  // runs a successful priming dispatch first, then injects the fault
  // on the second dispatch — covering the warm path under the same
  // five-row atomicity claim (Codex P2, bpxpmkba3 finding 1).
  //
  // Query-shape difference from cold:
  //   - No `onLoadDocument` SELECT — the doc is already resident, so
  //     Hocuspocus reuses the loaded Y.Doc instead of firing the hook.
  //     (The clone's tail SELECT still fires — it runs per transact.)
  //   - `INSERT doc_counters ... ON CONFLICT DO NOTHING` is a SQL-level
  //     no-op (row exists from prime) but the statement still executes
  //     and counts toward `callsIssued`.
  //   Net: 9 queries instead of cold's 10.
  describe("resident-doc path (warm write after prime)", () => {
    const EXPECTED_WARM_TX_QUERIES = 9;

    it("warm baseline: resident-doc write tx issues the expected shape of queries", async () => {
      const result = await runTrial({ faultOrdinal: 10_000, prime: true });
      expect(result.thrown).toBeNull();
      expect(result.faultTriggered).toBe(false);
      expect(result.docTitle).toBe("new");
      // prime + faulted-but-successful second dispatch = 2 doc_updates rows.
      expect(result.docUpdatesCount).toBe(2);
      expect(result.docUpdatedOutboxCount).toBe(2);
      expect(result.allowAuditCount).toBe(2);
      expect(result.auditAppendedOutboxCount).toBe(2);
      // Prime UPDATEd counter from 1 → 2; second dispatch UPDATEd 2 → 3.
      expect(result.counterNextSeq).toBe(3);
      expect(result.callsIssued).toBe(EXPECTED_WARM_TX_QUERIES);
      // Tag breakdown: no onLoadDocument SELECT (doc resident), but the
      // counter bootstrap INSERT still fires (ON CONFLICT DO NOTHING is
      // tx-local defence — see doc-updates-writer.ts docstring).
      expect(countInserts(result.tags, "audit_events")).toBe(1);
      expect(countInserts(result.tags, "doc_updates")).toBe(1);
      expect(countInserts(result.tags, "doc_counters")).toBe(1);
      // Event-discriminated outbox checks. See cold baseline.
      expect(countOutboxInserts(result.tags, "doc.updated")).toBe(1);
      expect(countOutboxInserts(result.tags, "audit.appended")).toBe(1);
      expect(result.docResidentAfterTrial).toBe(true);
      expect(MAX_ORDINAL).toBeGreaterThanOrEqual(EXPECTED_WARM_TX_QUERIES);
    });

    for (let ordinal = 1; ordinal <= MAX_ORDINAL; ordinal++) {
      it(`fault at ordinal ${ordinal} (warm): prime state is preserved`, async () => {
        const result = await runTrial({ faultOrdinal: ordinal, prime: true });

        if (result.thrown !== null) {
          expect(result.thrown).toBeInstanceOf(FaultInjectedError);
          expect((result.thrown as FaultInjectedError).ordinal).toBe(ordinal);
          expect(result.faultTriggered).toBe(true);
          // Rollback on warm path restores post-prime state:
          //   - docs.title === "prime" (the handler's UPDATE on the
          //     second dispatch rolls back; prime's committed title
          //     survives).
          //   - 1 doc_updates row (prime's seq=1 write is durable).
          //   - 1 allow audit (prime's) + 1 error audit (this dispatch's).
          //   - counterNextSeq === 2 (prime's UPDATE to 2 is durable;
          //     the faulted dispatch's bootstrap + SELECT + UPDATE
          //     sequence rolled back).
          expect(result.docTitle).toBe("prime");
          expect(result.docUpdatesCount).toBe(1);
          expect(result.docUpdatedOutboxCount).toBe(1);
          expect(result.allowAuditCount).toBe(1);
          expect(result.counterNextSeq).toBe(2);
          // Prime's `audit.appended` outbox row + this dispatch's
          // error audit's `audit.appended` outbox row. Both commit
          // (one in prime's write tx, one in the error path's
          // `withAuditTx`), so the counter is 2.
          expect(result.errorAuditCount).toBe(1);
          expect(result.auditAppendedOutboxCount).toBe(2);
          // In-memory residency on warm path under ADR 0043: the doc
          // is resident from the prime and STAYS resident on every
          // fault ordinal — rollback discards staged updates, never
          // the resident. The "late fault leaves hot doc polluted"
          // regression Codex flagged against the pre-0043 substrate
          // is structurally impossible now (the faulted dispatch
          // mutated a throwaway clone); the committed-only content
          // of the surviving resident is pinned in the sync suites.
          expect(result.docResidentAfterTrial).toBe(true);
        } else {
          // Fault past the tail — second dispatch committed on top of prime.
          expect(result.faultTriggered).toBe(false);
          expect(result.docTitle).toBe("new");
          expect(result.docUpdatesCount).toBe(2);
          expect(result.docUpdatedOutboxCount).toBe(2);
          expect(result.allowAuditCount).toBe(2);
          expect(result.errorAuditCount).toBe(0);
          expect(result.auditAppendedOutboxCount).toBe(2);
          expect(result.counterNextSeq).toBe(3);
          expect(result.docResidentAfterTrial).toBe(true);
        }
      });
    }
  });
});
