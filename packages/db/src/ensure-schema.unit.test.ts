import { afterEach, describe, expect, it } from "vitest";

import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { ensureSchema } from "./ensure-schema";

describe("ensureSchema", () => {
  let driver: SqliteDriver;

  afterEach(async () => {
    await driver.close();
  });

  it("applies the full DDL to a fresh database", () => {
    driver = createSqliteDriver({ path: ":memory:" });
    const before = driver.pragma("table_info(workspaces)");
    expect(Array.isArray(before) && before.length === 0).toBe(true);

    ensureSchema(driver);

    const after = driver.pragma("table_info(workspaces)");
    expect(Array.isArray(after) && after.length > 0).toBe(true);
  });

  it("is a no-op on an already-initialised database (restart-safe)", () => {
    driver = createSqliteDriver({ path: ":memory:" });
    ensureSchema(driver);
    // A second apply of the non-idempotent DDL would throw "table already
    // exists"; ensureSchema must detect the sentinel and skip.
    expect(() => ensureSchema(driver)).not.toThrow();
  });
});
