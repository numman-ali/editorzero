/**
 * `createLoadRoles` — Layer-1 role lookup unit test (ADR 0024).
 *
 * Boots a real in-memory SQLite driver with the full DDL so the
 * helper runs against the same schema the production resolver sees.
 * Exercises the four load-bearing contract points:
 *  (1) active row returns `[role]` (one role per row, wrapped array)
 *  (2) missing row returns `null` (strict — no fallback)
 *  (3) soft-deleted row returns `null` (filtered by `deleted_at IS NULL`)
 *  (4) composite-key scoping — right user in wrong workspace, or
 *      vice versa, returns `null`
 */

import { UserId, WorkspaceId } from "@editorzero/ids";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { SQLITE_FULL_DDL } from "./index";
import { createLoadRoles } from "./load-roles";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000a2");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

async function seedMember(params: {
  workspace_id: WorkspaceId;
  user_id: UserId;
  role: Role;
  deleted_at?: number | null;
}) {
  await driver
    .system()
    .insertInto("workspace_members")
    .values({
      workspace_id: params.workspace_id,
      user_id: params.user_id,
      role: params.role,
      created_at: 1,
      updated_at: 1,
      deleted_at: params.deleted_at ?? null,
    })
    .execute();
}

describe("createLoadRoles", () => {
  it("returns [role] for an active membership row", async () => {
    await seedMember({ workspace_id: WORKSPACE_A, user_id: ALICE, role: "owner" });
    const loadRoles = createLoadRoles(driver);
    const roles = await loadRoles(WORKSPACE_A, ALICE);
    expect(roles).toEqual(["owner"]);
  });

  it("returns null when no membership row exists (strict-on-missing)", async () => {
    // No seed — Alice has never been added to WORKSPACE_A.
    const loadRoles = createLoadRoles(driver);
    const roles = await loadRoles(WORKSPACE_A, ALICE);
    expect(roles).toBeNull();
  });

  it("returns null when the only row is soft-deleted", async () => {
    // ADR 0017 cascade leaves the row present with `deleted_at` set.
    // The resolver must treat this as "not a current member" — same
    // outcome as a missing row.
    await seedMember({
      workspace_id: WORKSPACE_A,
      user_id: ALICE,
      role: "owner",
      deleted_at: 999,
    });
    const loadRoles = createLoadRoles(driver);
    const roles = await loadRoles(WORKSPACE_A, ALICE);
    expect(roles).toBeNull();
  });

  it("returns null for user in wrong workspace (composite-key scoping)", async () => {
    // Bob is a member of WORKSPACE_B, not WORKSPACE_A. A principal
    // resolving against WORKSPACE_A must not see Bob's WORKSPACE_B role.
    await seedMember({ workspace_id: WORKSPACE_B, user_id: BOB, role: "admin" });
    const loadRoles = createLoadRoles(driver);
    const roles = await loadRoles(WORKSPACE_A, BOB);
    expect(roles).toBeNull();
  });

  it("returns null for different user in same workspace", async () => {
    // Alice is in WORKSPACE_A; Bob asking about WORKSPACE_A must not
    // inherit Alice's row.
    await seedMember({ workspace_id: WORKSPACE_A, user_id: ALICE, role: "owner" });
    const loadRoles = createLoadRoles(driver);
    const roles = await loadRoles(WORKSPACE_A, BOB);
    expect(roles).toBeNull();
  });

  it.each<Role>([
    "owner",
    "admin",
    "member",
    "guest",
  ])("returns [%s] for a row with that role", async (role) => {
    await seedMember({ workspace_id: WORKSPACE_A, user_id: ALICE, role });
    const loadRoles = createLoadRoles(driver);
    const roles = await loadRoles(WORKSPACE_A, ALICE);
    expect(roles).toEqual([role]);
  });
});
