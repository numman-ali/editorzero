/**
 * `workspace.member_add` — capability-level integration test.
 *
 * Runs the handler against real in-memory SQLite. Exercises the three
 * branches of ADR 0024 §5: fresh INSERT, revive-in-place (preserves
 * `created_at`, bumps `updated_at`, allows role change), and
 * `MemberAlreadyExistsError` when the target already has a live row.
 * Also covers Layer-2 tenant scoping (workspace-A handle cannot add a
 * member to workspace-B's roster).
 *
 * Race coverage for the concurrent-revive branch lives in an
 * integration suite with real concurrency; here we exercise the static
 * outcome (the defensive `deleted_at IS NOT NULL` predicate on the
 * revive UPDATE).
 */

import { createSqliteDriver, type SqliteDriver, WORKSPACE_MEMBERS_DDL } from "@editorzero/db";
import { MemberAlreadyExistsError } from "@editorzero/errors";
import { UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability, type Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { workspaceMemberAdd } from "./member_add";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const ALICE = UserId("018f0000-0000-7000-8000-0000000000a1");
const BOB = UserId("018f0000-0000-7000-8000-0000000000b1");
const CAROL = UserId("018f0000-0000-7000-8000-0000000000c1");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(WORKSPACE_MEMBERS_DDL);
});

afterEach(async () => {
  await driver.close();
});

function userPrincipal(
  workspace_id: WorkspaceId = WORKSPACE_A,
  caller_id: UserId = ALICE,
): UserPrincipal {
  return {
    kind: "user",
    id: caller_id,
    workspace_id,
    roles: ["owner"],
    session_id: null,
    token_id: null,
  };
}

function buildCtx(
  workspace_id: WorkspaceId,
  frozenNow = 5000,
  caller_id: UserId = ALICE,
): CapabilityContext {
  return {
    principal: userPrincipal(workspace_id, caller_id),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    transact: async () => {
      throw new Error("transact not exercised by workspace.member_add (metadata-only)");
    },
    outbox: () => {
      /* member_add emits no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
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

describe("workspace.member_add", () => {
  it("inserts a fresh member row (Branch C — never-member)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    const ctx = buildCtx(WORKSPACE_A, 7000);

    const out = await workspaceMemberAdd.handler(ctx, { user_id: BOB, role: "member" });
    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      user_id: BOB,
      role: "member",
      created_at: 7000,
      updated_at: 7000,
    });

    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select(["role", "created_at", "updated_at", "deleted_at"])
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      role: "member",
      created_at: 7000,
      updated_at: 7000,
      deleted_at: null,
    });
  });

  it("accepts all four roles on a fresh INSERT", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    const roles: readonly Role[] = ["owner", "admin", "member", "guest"];

    for (const [i, role] of roles.entries()) {
      const target = UserId(`018f0000-0000-7000-8000-0000000000e${i.toString(16)}`);
      const ctx = buildCtx(WORKSPACE_A, 9000 + i);
      const out = await workspaceMemberAdd.handler(ctx, { user_id: target, role });
      expect(out.role).toBe(role);
      expect(out.created_at).toBe(9000 + i);
    }
  });

  it("revives a soft-deleted member, preserving created_at and bumping updated_at (Branch B)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member", created_at: 100, deleted_at: 500 });
    const ctx = buildCtx(WORKSPACE_A, 8000);

    const out = await workspaceMemberAdd.handler(ctx, { user_id: BOB, role: "member" });
    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      user_id: BOB,
      role: "member",
      created_at: 100, // preserved across revive
      updated_at: 8000,
    });

    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select(["role", "created_at", "updated_at", "deleted_at"])
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      role: "member",
      created_at: 100,
      updated_at: 8000,
      deleted_at: null,
    });
  });

  it("revives with a different role (role changes across the soft-delete boundary)", async () => {
    // Bob was a member, got removed; admin re-adds him as admin now.
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member", created_at: 100, deleted_at: 500 });
    const ctx = buildCtx(WORKSPACE_A, 8000);

    const out = await workspaceMemberAdd.handler(ctx, { user_id: BOB, role: "admin" });
    expect(out.role).toBe("admin");
    expect(out.created_at).toBe(100);
    expect(out.updated_at).toBe(8000);
  });

  it("refuses 409 when the target is already a live member (Branch A)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member" });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(
      workspaceMemberAdd.handler(ctx, { user_id: BOB, role: "admin" }),
    ).rejects.toBeInstanceOf(MemberAlreadyExistsError);

    // DB confirms no write landed — role unchanged, no new row.
    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select(["role", "updated_at"])
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("member");
    expect(row.updated_at).toBe(100);
  });

  it("refuses 409 on same-role re-add (live member) — role match is not idempotent", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member" });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(
      workspaceMemberAdd.handler(ctx, { user_id: BOB, role: "member" }),
    ).rejects.toBeInstanceOf(MemberAlreadyExistsError);
  });

  it("allows adding a user as owner when another owner already exists", async () => {
    // No last-owner protection on member_add — the invariant only
    // bites when owners are *leaving*.
    await seedMember({ user_id: ALICE, role: "owner" });
    const ctx = buildCtx(WORKSPACE_A, 9000);

    const out = await workspaceMemberAdd.handler(ctx, { user_id: CAROL, role: "owner" });
    expect(out.role).toBe("owner");
    expect(out.created_at).toBe(9000);
  });

  it("Branch C `ON CONFLICT DO NOTHING` shape: a direct INSERT+ON CONFLICT against an existing PK yields no row", async () => {
    // This test pins the race guard Codex's review drove in at
    // slice follow-up: a plain INSERT would surface PG's 23505
    // (unique_violation) as a raw 500 because the global error
    // mapper does not project 23505 (see `app.unit.test.ts` — the
    // 23505-NOT-mapped test is load-bearing). The capability's
    // Branch C wraps its INSERT in `ON CONFLICT (workspace_id,
    // user_id) DO NOTHING RETURNING ...`, turning the race into a
    // zero-row return the handler can project to
    // `MemberAlreadyExistsError`.
    //
    // Static unit tests cannot interleave between the handler's
    // step 1 SELECT and its step 3 INSERT to reproduce the live
    // race; instead we assert the underlying Kysely shape by
    // firing the same `ON CONFLICT DO NOTHING RETURNING` INSERT
    // directly against a pre-seeded row and confirming zero rows
    // return — which is exactly the state Branch C throws
    // `MemberAlreadyExistsError` on. End-to-end race coverage is
    // deferred to a real-concurrency integration suite.
    await seedMember({ user_id: BOB, role: "member", created_at: 100 });

    const result = await driver
      .system()
      .insertInto("workspace_members")
      .values({
        workspace_id: WORKSPACE_A,
        user_id: BOB,
        role: "admin",
        created_at: 9999,
        updated_at: 9999,
        deleted_at: null,
      })
      .onConflict((oc) => oc.columns(["workspace_id", "user_id"]).doNothing())
      .returning(["user_id", "role"])
      .executeTakeFirst();

    expect(result).toBeUndefined();

    // Pre-seeded row untouched — ON CONFLICT DO NOTHING is not an
    // UPSERT; existing state is preserved.
    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select(["role", "created_at"])
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("member");
    expect(row.created_at).toBe(100);
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot revive or add into workspace-B", async () => {
    await seedMember({ workspace_id: WORKSPACE_A, user_id: ALICE, role: "owner" });
    // Bob is a soft-deleted member in workspace-B only.
    await seedMember({
      workspace_id: WORKSPACE_B,
      user_id: BOB,
      role: "member",
      created_at: 100,
      deleted_at: 500,
    });
    const ctxA = buildCtx(WORKSPACE_A, 9000);

    // From workspace-A's scoped handle, the SELECT cannot see
    // workspace-B's row. So member_add treats Bob as "never-member in
    // workspace-A" and performs a fresh INSERT (creating a second
    // membership row, one per workspace) — this is correct
    // multi-workspace behaviour.
    const out = await workspaceMemberAdd.handler(ctxA, { user_id: BOB, role: "admin" });
    expect(out.workspace_id).toBe(WORKSPACE_A);
    expect(out.role).toBe("admin");
    expect(out.created_at).toBe(9000);

    // Workspace-B's soft-deleted row is untouched.
    const rowB = await driver
      .system()
      .selectFrom("workspace_members")
      .select(["role", "deleted_at"])
      .where("workspace_id", "=", WORKSPACE_B)
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(rowB.role).toBe("member");
    expect(rowB.deleted_at).toBe(500);
  });

  // ── Input validation rails ──────────────────────────────────────────────

  it("rejects empty user_id", () => {
    const result = workspaceMemberAdd.input.safeParse({ user_id: "", role: "member" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown roles", () => {
    const result = workspaceMemberAdd.input.safeParse({ user_id: BOB, role: "superuser" });
    expect(result.success).toBe(false);
  });

  it("rejects missing role", () => {
    const result = workspaceMemberAdd.input.safeParse({ user_id: BOB });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = workspaceMemberAdd.input.safeParse({ user_id: BOB, role: "member", extra: 1 });
    expect(result.success).toBe(false);
  });

  // ── Metadata-only enrolment ────────────────────────────────────────────

  it("is registered in METADATA_ONLY_CAPABILITIES", () => {
    expect(isMetadataOnlyCapability("workspace.member_add")).toBe(true);
  });

  // ── Registry metadata ──────────────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(workspaceMemberAdd.id).toBe("workspace.member_add");
    expect(workspaceMemberAdd.category).toBe("mutation");
    expect(workspaceMemberAdd.requires).toEqual(["workspace:admin"]);
    expect(workspaceMemberAdd.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(workspaceMemberAdd.agentAllowed).toEqual({});
  });

  // ── Audit projections ──────────────────────────────────────────────────

  it("projects a user subject carrying the target user_id", () => {
    const subject = workspaceMemberAdd.audit.subjectFrom({ user_id: BOB, role: "member" });
    expect(subject).toEqual({ kind: "user", id: BOB });
  });

  it("emits an allow effect with member.add kind + workspace/user/role fields", () => {
    const effect = workspaceMemberAdd.audit.effectOnAllow(
      { user_id: BOB, role: "admin" },
      {
        workspace_id: WORKSPACE_A,
        user_id: BOB,
        role: "admin",
        created_at: 7000,
        updated_at: 7000,
      },
    );
    expect(effect.kind).toBe("member.add");
    if (effect.kind === "member.add") {
      expect(effect.workspace_id).toBe(WORKSPACE_A);
      expect(effect.user_id).toBe(BOB);
      expect(effect.role).toBe("admin");
    }
  });

  it("emits a deny effect carrying the reason code + admin scope requirement", () => {
    const effect = workspaceMemberAdd.audit.effectOnDeny(
      { user_id: BOB, role: "member" },
      { kind: "missing_scope", required: ["workspace:admin"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("workspace.member_add");
      expect(effect.required_scopes).toEqual(["workspace:admin"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on conflict via projectErrorAudit", () => {
    const effect = workspaceMemberAdd.audit.effectOnError(
      { user_id: BOB, role: "member" },
      { kind: "conflict" },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("workspace.member_add");
      expect(effect.error_code).toBe("conflict");
    }
  });

  it("declares a non-collapsing audit policy (mutations are not collapsed)", () => {
    expect(workspaceMemberAdd.audit.collapsePolicy).toEqual({ collapsible: false });
  });
});
