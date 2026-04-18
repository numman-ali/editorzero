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
