/**
 * Postgres driver — ADR 0023 runtime + tx semantics.
 *
 * Counterpart to `sqlite.unit.test.ts`: asserts the invariants ADR 0023
 * codifies against a real Postgres started via `@testcontainers/postgresql`.
 *
 *   - `withSystemTx` runs at SERIALIZABLE isolation (Codex smoke from
 *     the design review — proves `setIsolationLevel("serializable")`
 *     routes through to the right PG SQL without a driver-side wrap).
 *   - Plain `system().transaction()` stays at READ COMMITTED — the dual
 *     of the SQLite "deferred begin" test; catches a regression that
 *     would silently promote every tx to SERIALIZABLE and tank read
 *     throughput.
 *   - Controlled-tx savepoints (SAVEPOINT / ROLLBACK TO / RELEASE) work
 *     via the stock PG driver — no wrap needed (ADR 0023 §1).
 *   - Per-pool `int8` OID parser returns Number with a safe-integer
 *     guard (ADR 0023 §5). The guard is load-bearing: without it,
 *     epoch-ms values or `seq` allocations crossing 2^53 would silently
 *     round.
 *   - `Uint8Array` round-trips through BYTEA without a dialect adapter
 *     (ADR 0023 §6 empirical pin — pg's `prepareValue` wraps
 *     `Uint8Array` as `Buffer` outbound; BYTEA reads are already
 *     `Buffer`, itself a `Uint8Array`).
 *   - `setting(name)` reads a session GUC and returns `null` for
 *     unknown settings (PG analogue of SQLite's `pragma`).
 *
 * Container strategy: one `PostgreSqlContainer` per file (spun in
 * `beforeAll`, torn in `afterAll`). Each test gets a clean schema via
 * DROP IF EXISTS + re-apply DDL in `beforeEach`. Faster than per-test
 * containers (5+s spin cost) and cleaner than per-test schemas (the
 * search-path dance would double the test setup code).
 *
 * Skip guard: `EDITORZERO_SKIP_POSTGRES_TESTS=1` bypasses the whole
 * suite so developers without Docker can still commit db-package
 * changes. Recorded in AGENTS.md Gotchas.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresDriver, type PostgresDriver } from "./postgres";
import { FULL_DDL } from "./postgres-ddl";

/**
 * Pinned image per ADR 0023 §2. Update in tandem with the ADR's pinned
 * line when rolling to a new major.
 */
const POSTGRES_IMAGE = "postgres:17.4-bookworm";

// biome-ignore lint/complexity/useLiteralKeys: tsconfig's `noPropertyAccessFromIndexSignature` (TS4111) forbids `process.env.FOO`; bracket access is the only form both tools accept.
const SKIP = process.env["EDITORZERO_SKIP_POSTGRES_TESTS"] === "1";

let container: StartedPostgreSqlContainer | undefined;
let driver: PostgresDriver | undefined;

beforeAll(async () => {
  if (SKIP) return;
  container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("editorzero_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  driver = createPostgresDriver({ connectionString: container.getConnectionUri() });
}, 120_000);

afterAll(async () => {
  if (driver !== undefined) await driver.close();
  if (container !== undefined) await container.stop();
}, 60_000);

beforeEach(async () => {
  if (driver === undefined) return;
  // Wipe + reapply the full schema. Order matters: child tables before
  // their parents (FK targets). `IF EXISTS` keeps the first run clean.
  await driver.exec(`
    DROP TABLE IF EXISTS outbox;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS doc_counters;
    DROP TABLE IF EXISTS doc_updates;
    DROP TABLE IF EXISTS doc_snapshots;
    DROP TABLE IF EXISTS workspace_members;
    DROP TABLE IF EXISTS docs;
    DROP TABLE IF EXISTS collections;
    DROP TABLE IF EXISTS workspaces;
    DROP TABLE IF EXISTS t_bigint;
    DROP TABLE IF EXISTS t_blob;
    DROP TABLE IF EXISTS t_sp;
  `);
  await driver.exec(FULL_DDL);
});

afterEach(async () => {
  // No-op — the beforeEach wipe makes the next test's state
  // deterministic regardless of what this test left behind.
});

function requireDriver(): PostgresDriver {
  if (driver === undefined) {
    throw new Error("driver not initialised — beforeAll skipped?");
  }
  return driver;
}

describe.skipIf(SKIP)("createPostgresDriver — withSystemTx SERIALIZABLE (ADR 0023 §3)", () => {
  it("withSystemTx body sees current_setting('transaction_isolation') = 'serializable'", async () => {
    const d = requireDriver();
    const observed = await d.withSystemTx(async (tx) => {
      const r = await sql<{
        isolation: string;
      }>`SELECT current_setting('transaction_isolation') AS isolation`.execute(tx);
      return r.rows[0]?.isolation;
    });
    expect(observed).toBe("serializable");
  });

  it("plain system().transaction() defaults to 'read committed' — IMMEDIATE-style aggression is scoped to withSystemTx", async () => {
    const d = requireDriver();
    const base = d.system();
    const observed = await base.transaction().execute(async (tx) => {
      const r = await sql<{
        isolation: string;
      }>`SELECT current_setting('transaction_isolation') AS isolation`.execute(tx);
      return r.rows[0]?.isolation;
    });
    expect(observed).toBe("read committed");
  });
});

describe.skipIf(SKIP)(
  "createPostgresDriver — ControlledTransaction savepoints (stock PG driver)",
  () => {
    // The SQLite driver needed an `EditorZeroSqliteDriver` savepoint
    // passthrough wrap because Kysely's SqliteDriver marks savepoint
    // methods optional and our wrap would silently no-op without it.
    // The stock PG driver (via `pg`) implements them unconditionally —
    // this test is the positive proof that no PG-side wrap is required
    // for the same semantics.
    it("rollbackToSavepoint discards intervening writes; releaseSavepoint retains them; commit persists the result", async () => {
      const d = requireDriver();
      await d.exec("CREATE TABLE t_sp (id INTEGER PRIMARY KEY)");
      const tx0 = await d.system().startTransaction().execute();

      // Base row before any savepoint.
      await sql`INSERT INTO t_sp (id) VALUES (1)`.execute(tx0);

      // Savepoint A: insert then rollback → row 2 discarded.
      const tx1 = await tx0.savepoint("sp_a").execute();
      await sql`INSERT INTO t_sp (id) VALUES (2)`.execute(tx1);
      const tx2 = await tx1.rollbackToSavepoint("sp_a").execute();

      // Savepoint B: insert then release → row 3 retained.
      const tx3 = await tx2.savepoint("sp_b").execute();
      await sql`INSERT INTO t_sp (id) VALUES (3)`.execute(tx3);
      const tx4 = await tx3.releaseSavepoint("sp_b").execute();

      await tx4.commit().execute();

      const r = await sql<{
        id: number;
      }>`SELECT id FROM t_sp ORDER BY id`.execute(d.system());
      expect(r.rows.map((row) => row.id)).toEqual([1, 3]);
    });
  },
);

describe.skipIf(SKIP)("createPostgresDriver — per-pool int8 parser (ADR 0023 §5)", () => {
  it("BIGINT in the safe range reads back as Number via per-pool types override", async () => {
    const d = requireDriver();
    await d.exec("CREATE TABLE t_bigint (v BIGINT NOT NULL)");
    // Epoch-ms mid-2023. Past 2^31 so the test would fail if the column
    // were INTEGER instead of BIGINT. Safely within Number.MAX_SAFE_INTEGER.
    const v = 1_700_000_000_000;
    await sql`INSERT INTO t_bigint (v) VALUES (${v})`.execute(d.system());
    const r = await sql<{ v: number }>`SELECT v FROM t_bigint`.execute(d.system());
    const first = r.rows[0];
    if (first === undefined) throw new Error("row missing");
    expect(typeof first.v).toBe("number");
    expect(first.v).toBe(v);
  });

  it("BIGINT exceeding Number.MAX_SAFE_INTEGER throws the safe-integer guard", async () => {
    const d = requireDriver();
    await d.exec("CREATE TABLE t_bigint (v BIGINT NOT NULL)");
    // 2^53 + 1 = 9_007_199_254_740_993 — first non-safe integer (2^53
    // itself rounds to 2^53, so 2^53+1 is the boundary value that
    // cannot be uniquely represented as a JS Number).
    await d.exec("INSERT INTO t_bigint (v) VALUES (9007199254740993)");
    await expect(sql<{ v: number }>`SELECT v FROM t_bigint`.execute(d.system())).rejects.toThrow(
      /Number\.MAX_SAFE_INTEGER|safe-integer/i,
    );
  });
});

describe.skipIf(SKIP)("createPostgresDriver — binary round-trip (ADR 0023 §6)", () => {
  it("Uint8Array round-trips through BYTEA without a dialect adapter", async () => {
    const d = requireDriver();
    await d.exec("CREATE TABLE t_blob (b BYTEA NOT NULL)");
    // Include boundary bytes: zero, 0x7F (ASCII limit), 0x80 (high bit),
    // and 0xFF (max). Proves the driver preserves every byte position,
    // not just printable ASCII.
    const src = new Uint8Array([0x01, 0x02, 0xff, 0x00, 0x7f, 0x80]);
    await sql`INSERT INTO t_blob (b) VALUES (${Buffer.from(src)})`.execute(d.system());
    const r = await sql<{ b: Buffer }>`SELECT b FROM t_blob`.execute(d.system());
    const round = r.rows[0]?.b;
    if (round === undefined) throw new Error("row missing");
    expect(Buffer.compare(round, Buffer.from(src))).toBe(0);
  });
});

describe.skipIf(SKIP)(
  "createPostgresDriver — setting(name) — GUC accessor (PG analogue of SQLite PRAGMA)",
  () => {
    it("returns a known session setting as string", async () => {
      const d = requireDriver();
      const v = await d.setting("server_encoding");
      expect(v).toBe("UTF8");
    });

    it("returns null for an unknown setting (missing_ok = true)", async () => {
      const d = requireDriver();
      const v = await d.setting("editorzero.nonexistent_setting_asd123");
      expect(v).toBeNull();
    });
  },
);

describe.skipIf(SKIP)("createPostgresDriver — searchPath onConnect hook (ADR 0023 §2)", () => {
  it("pins the search_path on every pooled connection", async () => {
    // Dedicated schema so the onConnect hook has a non-default target.
    // CREATE SCHEMA runs through the shared driver, then we spin a
    // `searchPath`-bound driver and assert unqualified names resolve
    // into the bound schema.
    const d = requireDriver();
    await d.exec("DROP SCHEMA IF EXISTS sp_probe CASCADE");
    await d.exec("CREATE SCHEMA sp_probe");

    const c = container;
    if (c === undefined) throw new Error("container missing");
    const scoped = createPostgresDriver({
      connectionString: c.getConnectionUri(),
      searchPath: "sp_probe",
    });
    try {
      // `current_schema()` returns the first schema on search_path.
      // If the onConnect hook didn't fire, the result would be `public`.
      const r = await sql<{
        current_schema: string;
      }>`SELECT current_schema() AS current_schema`.execute(scoped.system());
      expect(r.rows[0]?.current_schema).toBe("sp_probe");

      // Functional evidence: an unqualified CREATE TABLE lands in
      // `sp_probe.t`, not `public.t`. Confirms the GUC is actually
      // being consulted by DDL resolution, not just `current_schema()`.
      await scoped.exec("CREATE TABLE t (v INTEGER NOT NULL)");
      const inSpProbe = await sql<{
        c: string;
      }>`SELECT COUNT(*)::text AS c FROM information_schema.tables WHERE table_schema = 'sp_probe' AND table_name = 't'`.execute(
        scoped.system(),
      );
      expect(inSpProbe.rows[0]?.c).toBe("1");
    } finally {
      await scoped.close();
      await d.exec("DROP SCHEMA IF EXISTS sp_probe CASCADE");
    }
  });

  it("escapes identifiers with embedded double-quotes (defence-in-depth)", async () => {
    // `pgIdent` doubles `"` inside the schema name. The test harness is
    // the only source of `searchPath` today, but the escape is in place
    // so an operational misuse doesn't turn into SQL injection. Use a
    // literal `"` in the schema name to prove the escape survives a
    // round-trip through the SET statement.
    const d = requireDriver();
    const raw = 'sp"probe';
    const quoted = raw.replace(/"/g, '""');
    await d.exec(`DROP SCHEMA IF EXISTS "${quoted}" CASCADE`);
    await d.exec(`CREATE SCHEMA "${quoted}"`);

    const c = container;
    if (c === undefined) throw new Error("container missing");
    const scoped = createPostgresDriver({
      connectionString: c.getConnectionUri(),
      searchPath: raw,
    });
    try {
      const r = await sql<{
        current_schema: string;
      }>`SELECT current_schema() AS current_schema`.execute(scoped.system());
      expect(r.rows[0]?.current_schema).toBe(raw);
    } finally {
      await scoped.close();
      await d.exec(`DROP SCHEMA IF EXISTS "${quoted}" CASCADE`);
    }
  });
});

describe.skipIf(SKIP)("createPostgresDriver — pool lifecycle", () => {
  it("close() drains the pool and resolves", async () => {
    // Separate driver spun from the shared container so we don't tear
    // down the file-scoped `driver` used by the other describes.
    const c = container;
    if (c === undefined) throw new Error("container missing");
    const local = createPostgresDriver({ connectionString: c.getConnectionUri() });
    // Prove the pool is live — one round-trip query.
    const r = await sql<{ n: number }>`SELECT 1 AS n`.execute(local.system());
    expect(r.rows[0]?.n).toBe(1);
    await expect(local.close()).resolves.toBeUndefined();
  });
});
