/**
 * `onConflictPersonalSpaceDoNothing` — real in-memory SQLite against
 * the real `spaces_personal_unique` partial index. Pins the property
 * the signup bootstrap relies on: a retry with a DIFFERENT space id
 * but the same `(workspace_id, owner_user_id)` no-ops instead of
 * erroring, and the conflict target actually matches the partial
 * index (a bound-parameter predicate would fail at prepare time).
 */

import { SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { onConflictPersonalSpaceDoNothing } from "./conflict-targets";
import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { SPACES_DDL } from "./drivers/sqlite-ddl";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const OWNER = UserId("018f0000-0000-7000-8000-0000000000a1");
const SPACE_1 = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const SPACE_2 = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const SPACE_3 = SpaceId("018f0000-0000-7000-8000-0000000000e3");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SPACES_DDL);
});

afterEach(async () => {
  await driver.close();
});

function insertPersonal(id: SpaceId, slug: string) {
  return driver
    .system()
    .insertInto("spaces")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      kind: "personal",
      type: "private",
      owner_user_id: OWNER,
      name: "Personal",
      slug,
      baseline_access: "view",
      created_by: OWNER,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .onConflict(onConflictPersonalSpaceDoNothing)
    .returning("id")
    .executeTakeFirst();
}

describe("onConflictPersonalSpaceDoNothing", () => {
  it("first insert returns the row; a different-id retry for the same owner no-ops", async () => {
    const first = await insertPersonal(SPACE_1, "personal");
    expect(first?.id).toBe(SPACE_1);

    // The bootstrap-retry shape: a fresh id, same (workspace, owner).
    // The PK would never collide — only the partial-index target does.
    const retry = await insertPersonal(SPACE_2, "personal-retry");
    expect(retry).toBeUndefined();

    const rows = await driver.system().selectFrom("spaces").select(["id"]).execute();
    expect(rows).toEqual([{ id: SPACE_1 }]);
  });

  it("a soft-deleted personal space does not block a re-seed (index is live-rows-only)", async () => {
    await insertPersonal(SPACE_1, "personal");
    await driver
      .system()
      .updateTable("spaces")
      .set({ deleted_at: 42 })
      .where("id", "=", SPACE_1)
      .execute();

    const reseed = await insertPersonal(SPACE_3, "personal-2");
    expect(reseed?.id).toBe(SPACE_3);
  });
});
