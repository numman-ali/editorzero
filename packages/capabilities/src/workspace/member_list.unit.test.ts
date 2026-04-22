/**
 * `workspace.member_list` — capability-level integration test.
 *
 * Runs the handler against real in-memory SQLite; Layer-2 tenant
 * isolation is owned by `packages/db/src/tenant.unit.test.ts` (the
 * tenant-scope tests for `workspace_members`). Here we confirm the
 * capability composes with that layer (a workspace-A ctx does not
 * see workspace-B's members) and that the composite-cursor
 * pagination, role filter, and active-only projection all work
 * against the real DDL.
 */

import { createSqliteDriver, type SqliteDriver, WORKSPACE_MEMBERS_DDL } from "@editorzero/db";
import { UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { workspaceMemberList } from "./member_list";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000b1");
const CAROL = UserId("018f0000-0000-7000-8000-0000000000c1");
const DAVE = UserId("018f0000-0000-7000-8000-0000000000d1");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(WORKSPACE_MEMBERS_DDL);
});

afterEach(async () => {
  await driver.close();
});

function userPrincipal(workspace_id: WorkspaceId = WORKSPACE_A): UserPrincipal {
  return {
    kind: "user",
    id: ALICE,
    workspace_id,
    roles: ["owner"],
    session_id: null,
    token_id: null,
  };
}

function buildCtx(workspace_id: WorkspaceId): CapabilityContext {
  return {
    principal: userPrincipal(workspace_id),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    transact: async () => {
      throw new Error("transact not exercised by workspace.member_list (read)");
    },
    outbox: () => {
      /* member_list is a read — no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 1,
  };
}

interface SeedMember {
  workspace_id?: WorkspaceId;
  user_id: UserId;
  role?: Role;
  created_at?: number;
  deleted_at?: number | null;
}

async function seedMember(m: SeedMember) {
  await driver
    .system()
    .insertInto("workspace_members")
    .values({
      workspace_id: m.workspace_id ?? WORKSPACE_A,
      user_id: m.user_id,
      role: m.role ?? "member",
      created_at: m.created_at ?? 100,
      updated_at: m.created_at ?? 100,
      deleted_at: m.deleted_at ?? null,
    })
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("workspace.member_list", () => {
  it("returns empty list + null cursor when workspace has no members", async () => {
    const ctx = buildCtx(WORKSPACE_A);
    const out = await workspaceMemberList.handler(ctx, { limit: 50 });
    expect(out).toEqual({ members: [], next_cursor: null });
  });

  it("returns active members ordered by created_at desc, user_id desc", async () => {
    await seedMember({ user_id: ALICE, role: "owner", created_at: 100 });
    await seedMember({ user_id: BOB, role: "admin", created_at: 200 });
    await seedMember({ user_id: CAROL, role: "member", created_at: 300 });
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceMemberList.handler(ctx, { limit: 50 });
    expect(out.members.map((m) => m.user_id)).toEqual([CAROL, BOB, ALICE]);
    expect(out.next_cursor).toBeNull();
  });

  it("excludes soft-deleted members (active-only in slice 1)", async () => {
    await seedMember({ user_id: ALICE, role: "owner", created_at: 100 });
    await seedMember({ user_id: BOB, created_at: 200, deleted_at: 999 });
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceMemberList.handler(ctx, { limit: 50 });
    expect(out.members.map((m) => m.user_id)).toEqual([ALICE]);
  });

  it("paginates via composite cursor (limit=2 then continue)", async () => {
    await seedMember({ user_id: ALICE, role: "owner", created_at: 100 });
    await seedMember({ user_id: BOB, role: "admin", created_at: 200 });
    await seedMember({ user_id: CAROL, role: "member", created_at: 300 });
    const ctx = buildCtx(WORKSPACE_A);

    const page1 = await workspaceMemberList.handler(ctx, { limit: 2 });
    expect(page1.members.map((m) => m.user_id)).toEqual([CAROL, BOB]);
    expect(page1.next_cursor).toEqual({ before_created_at: 200, before_user_id: BOB });
    const cursor = page1.next_cursor;
    if (cursor === null) throw new Error("expected cursor on page 1");

    const page2 = await workspaceMemberList.handler(ctx, {
      limit: 2,
      before_created_at: cursor.before_created_at,
      before_user_id: cursor.before_user_id,
    });
    expect(page2.members.map((m) => m.user_id)).toEqual([ALICE]);
    expect(page2.next_cursor).toBeNull();
  });

  it("tiebreaks on user_id when multiple members share created_at", async () => {
    // Same created_at for all three — collision-safe cursor matters.
    // `user_id desc` determines the in-page order; the cursor
    // `user_id <` predicate continues strictly after the last row.
    await seedMember({ user_id: ALICE, created_at: 100 });
    await seedMember({ user_id: BOB, created_at: 100 });
    await seedMember({ user_id: CAROL, created_at: 100 });
    const ctx = buildCtx(WORKSPACE_A);

    const page1 = await workspaceMemberList.handler(ctx, { limit: 2 });
    // `desc` on string user_ids → CAROL ("...c1") > BOB ("...b1") > ALICE ("...a1").
    expect(page1.members.map((m) => m.user_id)).toEqual([CAROL, BOB]);
    expect(page1.next_cursor).toEqual({ before_created_at: 100, before_user_id: BOB });

    const page2 = await workspaceMemberList.handler(ctx, {
      limit: 2,
      before_created_at: 100,
      before_user_id: BOB,
    });
    expect(page2.members.map((m) => m.user_id)).toEqual([ALICE]);
    expect(page2.next_cursor).toBeNull();
  });

  it("filters by role (only returns matching role)", async () => {
    await seedMember({ user_id: ALICE, role: "owner", created_at: 100 });
    await seedMember({ user_id: BOB, role: "admin", created_at: 200 });
    await seedMember({ user_id: CAROL, role: "member", created_at: 300 });
    await seedMember({ user_id: DAVE, role: "admin", created_at: 400 });
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceMemberList.handler(ctx, { limit: 50, role: "admin" });
    expect(out.members.map((m) => m.user_id)).toEqual([DAVE, BOB]);
  });

  it("composes with Layer-2 scoping: workspace-A ctx does not see workspace-B members", async () => {
    await seedMember({ workspace_id: WORKSPACE_A, user_id: ALICE, role: "owner" });
    await seedMember({ workspace_id: WORKSPACE_B, user_id: BOB, role: "owner" });
    const ctxA = buildCtx(WORKSPACE_A);

    const out = await workspaceMemberList.handler(ctxA, { limit: 50 });
    expect(out.members.map((m) => m.user_id)).toEqual([ALICE]);
  });

  // ── Input validation rails ──────────────────────────────────────────────

  it("rejects half-a-cursor (before_created_at without before_user_id)", () => {
    const result = workspaceMemberList.input.safeParse({ before_created_at: 100 });
    expect(result.success).toBe(false);
  });

  it("rejects half-a-cursor (before_user_id without before_created_at)", () => {
    const result = workspaceMemberList.input.safeParse({ before_user_id: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects limit above 200 / below 1", () => {
    expect(workspaceMemberList.input.safeParse({ limit: 0 }).success).toBe(false);
    expect(workspaceMemberList.input.safeParse({ limit: 201 }).success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = workspaceMemberList.input.safeParse({ bogus: 1 });
    expect(result.success).toBe(false);
  });

  // ── Registry metadata ──────────────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(workspaceMemberList.id).toBe("workspace.member_list");
    expect(workspaceMemberList.category).toBe("read");
    expect(workspaceMemberList.requires).toEqual(["workspace:admin"]);
    expect(workspaceMemberList.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
  });

  // ── Audit projections ──────────────────────────────────────────────────

  it("projects a workspace subject (no id — audit row's workspace_id column carries it)", () => {
    const subject = workspaceMemberList.audit.subjectFrom({ limit: 50 });
    expect(subject).toEqual({ kind: "workspace" });
  });

  it("emits an audit.access_log allow-effect (read-shaped)", () => {
    const effect = workspaceMemberList.audit.effectOnAllow(
      { limit: 50 },
      { members: [], next_cursor: null },
    );
    expect(effect).toEqual({ kind: "audit.access_log" });
  });

  it("emits a deny effect carrying the reason code + admin scope requirement", () => {
    const effect = workspaceMemberList.audit.effectOnDeny(
      { limit: 50 },
      { kind: "missing_scope", required: ["workspace:admin"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("workspace.member_list");
      expect(effect.required_scopes).toEqual(["workspace:admin"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("declares a collapsible audit policy with a constant bucket (same shape as audit.list)", () => {
    const policy = workspaceMemberList.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(typeof policy.window_ms).toBe("number");
      expect(policy.collapseKey({ limit: 50 })).toBe("workspace.member_list");
      expect(policy.collapseKey({ limit: 10, role: "owner" })).toBe("workspace.member_list");
    }
  });
});
