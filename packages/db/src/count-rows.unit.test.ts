import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countTableRows } from "./count-rows";
import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { FULL_DDL } from "./drivers/sqlite-ddl";

describe("countTableRows", () => {
  let driver: SqliteDriver;

  beforeEach(() => {
    driver = createSqliteDriver({ path: ":memory:" });
    driver.exec(FULL_DDL);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("counts rows in a table outside the typed schema", async () => {
    // Simulates the Better Auth `user` table the registration gate
    // counts — present in the same file, absent from SystemDatabase.
    driver.exec(`CREATE TABLE side_table (id TEXT PRIMARY KEY);`);
    expect(await countTableRows(driver.system(), "side_table")).toBe(0);
    driver.exec(`INSERT INTO side_table (id) VALUES ('a'), ('b');`);
    expect(await countTableRows(driver.system(), "side_table")).toBe(2);
  });

  it("quotes the identifier (a hostile table name fails, not injects)", async () => {
    await expect(countTableRows(driver.system(), 'x"; DROP TABLE docs; --')).rejects.toThrow();
    // The docs table survived the attempt.
    expect(await countTableRows(driver.system(), "docs")).toBe(0);
  });
});
