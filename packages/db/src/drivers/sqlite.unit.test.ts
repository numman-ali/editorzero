/**
 * SQLite driver — ADR 0007 runtime pragma conformance.
 *
 * The invariant: every `createSqliteDriver` hands back a connection
 * with the pragma set documented in ADR 0007 §"SQLite runtime pragmas"
 * already applied. Without this, tests and load work run against a
 * different SQLite than the architecture sizes (default
 * `journal_mode=delete`, no FK enforcement, no busy wait) — a class
 * of bug red-team pass #4 flagged as F91.
 *
 * `:memory:` is used for the pragmas that take effect in-memory
 * (`foreign_keys`, `busy_timeout`, `synchronous`). For the WAL-family
 * pragmas we open a real file under `os.tmpdir()` because
 * `journal_mode=WAL` silently stays at `memory` on a memory db.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompiledQuery } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteDriver, type SqliteDriver } from "./sqlite";

// `pragma()` returns `unknown`; better-sqlite3 gives back either
// a primitive or `[{ <pragma_name>: <value> }]`. Both forms appear
// in these tests; narrowing is handled per-call.
function pragmaNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (Array.isArray(value) && value[0] && typeof value[0] === "object") {
    const row = value[0] as Record<string, unknown>;
    const first = Object.values(row)[0];
    if (typeof first === "number") return first;
  }
  throw new Error(`expected numeric pragma value, got ${JSON.stringify(value)}`);
}

function pragmaString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value[0] && typeof value[0] === "object") {
    const row = value[0] as Record<string, unknown>;
    const first = Object.values(row)[0];
    if (typeof first === "string") return first;
  }
  throw new Error(`expected string pragma value, got ${JSON.stringify(value)}`);
}

describe("createSqliteDriver — ADR 0007 runtime pragmas (in-memory)", () => {
  let driver: SqliteDriver;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
  });

  afterEach(async () => {
    await driver.close();
  });

  it("foreign_keys = ON (1) — enforced per connection; default is OFF", () => {
    expect(pragmaNumber(driver.pragma("foreign_keys"))).toBe(1);
  });

  it("busy_timeout = 5000ms — 5s wait before SQLITE_BUSY bubbles up", () => {
    expect(pragmaNumber(driver.pragma("busy_timeout"))).toBe(5000);
  });

  it("synchronous = NORMAL (1) — fsync on commit, not on every page", () => {
    expect(pragmaNumber(driver.pragma("synchronous"))).toBe(1);
  });
});

describe("createSqliteDriver — ADR 0007 runtime pragmas (file-backed)", () => {
  // WAL + journal_size_limit + wal_autocheckpoint only take effect on
  // a real file. `:memory:` silently keeps journal_mode=memory.
  let tmpDir: string;
  let driver: SqliteDriver;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ez-db-pragma-"));
    driver = createSqliteDriver({ path: join(tmpDir, "test.db") });
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("journal_mode = WAL — concurrent readers + single writer", () => {
    expect(pragmaString(driver.pragma("journal_mode"))).toBe("wal");
  });

  it("wal_autocheckpoint = 1000 frames (~4 MB @ 4KiB pages)", () => {
    expect(pragmaNumber(driver.pragma("wal_autocheckpoint"))).toBe(1000);
  });

  it("journal_size_limit = 67108864 bytes (64 MiB)", () => {
    expect(pragmaNumber(driver.pragma("journal_size_limit"))).toBe(67108864);
  });
});

describe("createSqliteDriver — withSystemTx issues BEGIN IMMEDIATE (§6.4)", () => {
  // Two file-backed writers on the same DB prove the lock semantics.
  // `BEGIN IMMEDIATE` acquires the RESERVED lock at tx start; plain
  // `BEGIN` (SQLite's default) defers lock acquisition to the first
  // write. The observable difference: with IMMEDIATE, a second writer
  // trying to BEGIN IMMEDIATE on the same file sees SQLITE_BUSY at
  // begin time even if the first tx has performed no writes yet.
  //
  // Architecture.md §6.4 pins the write-path on IMMEDIATE because the
  // `doc_counters` seq allocator does SELECT-then-UPDATE; under plain
  // BEGIN, two concurrent write-path tx can lock-upgrade between the
  // SELECT and the UPDATE and deadlock. This test catches a regression
  // that silently replaces the dialect with plain Kysely `SqliteDialect`.
  let tmpDir: string;
  let writerA: SqliteDriver;
  let writerB: SqliteDriver;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ez-db-immediate-"));
    const dbPath = join(tmpDir, "test.db");
    writerA = createSqliteDriver({ path: dbPath });
    writerA.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    writerB = createSqliteDriver({ path: dbPath });
    // Shorten B's busy_timeout so the contention surfaces fast. The
    // default of 5000 ms would stretch each run to the full wait.
    writerB.pragma("busy_timeout = 100");
  });

  afterEach(async () => {
    await writerB.close();
    await writerA.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a second writer contending at BEGIN observes SQLITE_BUSY, not a successful deferred begin", async () => {
    let txAOpen = false;
    let releaseA!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const txAPromise = writerA.withSystemTx(async () => {
      txAOpen = true;
      await held;
    });

    // Yield so txA's BEGIN IMMEDIATE lands before B attempts its own.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(txAOpen).toBe(true);

    // Under BEGIN IMMEDIATE on A, this call contends on the RESERVED
    // lock and reports a BUSY-family error after ~100 ms. Under plain
    // BEGIN on A (the regression), it would open successfully because
    // A holds no lock until a write happens.
    await expect(writerB.withSystemTx(async () => undefined)).rejects.toThrow(/busy|locked/i);

    releaseA();
    await txAPromise;
  });
});

describe("createSqliteDriver — non-withSystemTx transactions use deferred BEGIN", () => {
  // The dual of the `withSystemTx → BEGIN IMMEDIATE` contract: every
  // *other* transaction opened on the base Kysely must use SQLite's
  // default DEFERRED begin, which takes no lock until the first write.
  // A regression that put every transaction on IMMEDIATE would (a)
  // serialise all readers at the RESERVED lock and (b) make
  // `system().transaction()` fail outright on readonly connections
  // (IMMEDIATE needs a writer lock the readonly connection can't
  // acquire). This test holds a plain `system().transaction()` open on
  // writer A and proves writer B's `withSystemTx` still succeeds —
  // impossible if A's tx had taken RESERVED at BEGIN time.
  let tmpDir: string;
  let writerA: SqliteDriver;
  let writerB: SqliteDriver;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ez-db-deferred-"));
    const dbPath = join(tmpDir, "test.db");
    writerA = createSqliteDriver({ path: dbPath });
    writerA.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    writerB = createSqliteDriver({ path: dbPath });
    writerB.pragma("busy_timeout = 100");
  });

  afterEach(async () => {
    await writerB.close();
    await writerA.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a plain system().transaction() takes no lock at BEGIN; concurrent withSystemTx on another writer succeeds", async () => {
    let txAOpen = false;
    let releaseA!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const txAPromise = writerA
      .system()
      .transaction()
      .execute(async () => {
        txAOpen = true;
        await held;
      });

    // Yield so txA's plain BEGIN lands before B attempts its own IMMEDIATE.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(txAOpen).toBe(true);

    // Writer A's plain BEGIN (DEFERRED) holds no lock, so writer B's
    // IMMEDIATE can acquire RESERVED and commit. A regression that
    // routes all transactions through IMMEDIATE would surface here as
    // a BUSY error on writer B.
    await expect(writerB.withSystemTx(async () => undefined)).resolves.toBeUndefined();

    releaseA();
    await txAPromise;
  });
});

describe("createSqliteDriver — ControlledTransaction savepoints pass through the wrap", () => {
  // The stock Kysely SqliteDriver implements savepoint /
  // rollbackToSavepoint / releaseSavepoint unconditionally, but our
  // wrap has to re-declare them — the Driver interface marks these
  // optional, and without explicit delegation Kysely's call-site
  // optional-chain silently no-ops them. The failure mode is subtle:
  // `tx.rollbackToSavepoint("x").execute()` resolves with no error
  // while issuing zero SQL, and writes the caller expected to be
  // rolled back persist through to COMMIT.
  //
  // This test exercises all three methods in one run — a savepoint
  // that's rolled back (row never lands) and a savepoint that's
  // released (row stays). A regression that drops any of the three
  // passthroughs would land the wrong row set at COMMIT.
  let tmpDir: string;
  let driver: SqliteDriver;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ez-db-savepoint-"));
    driver = createSqliteDriver({ path: join(tmpDir, "test.db") });
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  });

  afterEach(async () => {
    await driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rollbackToSavepoint discards intervening writes; releaseSavepoint retains them; commit persists the result", async () => {
    const tx0 = await driver.system().startTransaction().execute();

    // Base row, before any savepoint.
    await tx0.executeQuery(CompiledQuery.raw("INSERT INTO t (id) VALUES (1)"));

    // Savepoint A: insert + rollback → row 2 discarded.
    const tx1 = await tx0.savepoint("sp_a").execute();
    await tx1.executeQuery(CompiledQuery.raw("INSERT INTO t (id) VALUES (2)"));
    const tx2 = await tx1.rollbackToSavepoint("sp_a").execute();

    // Savepoint B: insert + release → row 3 retained.
    const tx3 = await tx2.savepoint("sp_b").execute();
    await tx3.executeQuery(CompiledQuery.raw("INSERT INTO t (id) VALUES (3)"));
    const tx4 = await tx3.releaseSavepoint("sp_b").execute();

    await tx4.commit().execute();

    const result = await driver
      .system()
      .executeQuery<{ id: number }>(CompiledQuery.raw("SELECT id FROM t ORDER BY id"));
    expect(result.rows.map((r) => r.id)).toEqual([1, 3]);
  });
});

describe("createSqliteDriver — readonly skips write-side pragmas", () => {
  // A readonly connection cannot run PRAGMA journal_mode=WAL (would
  // need to create a -wal file) or the other write-side knobs. Verify
  // the driver skips them and still applies the read-side set so
  // FK enforcement / busy wait are on for readers too.
  let tmpDir: string;
  let writer: SqliteDriver;
  let reader: SqliteDriver;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ez-db-pragma-ro-"));
    const dbPath = join(tmpDir, "test.db");
    // Create the file + table via a writer first — better-sqlite3
    // rejects readonly-opening a non-existent file.
    writer = createSqliteDriver({ path: dbPath });
    writer.exec("CREATE TABLE t (id INTEGER)");
    reader = createSqliteDriver({ path: dbPath, readonly: true });
  });

  afterEach(async () => {
    await reader.close();
    await writer.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readonly connection still enforces foreign_keys", () => {
    expect(pragmaNumber(reader.pragma("foreign_keys"))).toBe(1);
  });

  it("readonly connection still applies the busy_timeout", () => {
    expect(pragmaNumber(reader.pragma("busy_timeout"))).toBe(5000);
  });
});
