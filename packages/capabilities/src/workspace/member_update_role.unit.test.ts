/**
 * `workspace.member_update_role` — capability-level integration test.
 *
 * Runs the handler against real in-memory SQLite. Exercises the 404
 * vs. 409 vs. 400 branches, plus the happy-path promote/demote and
 * the last-owner invariant. The last-owner check is atomic with the
 * UPDATE (same write-path tx — `ctx.db` is tx-bound for
 * metadata-only capabilities); here we exercise the static outcome
 * to nail down the contract and leave a TOCTOU-style race to an
 * integration suite with real concurrency.
 */

import { createSqliteDriver, type SqliteDriver, WORKSPACE_MEMBERS_DDL } from "@editorzero/db";
import { LastOwnerError, NotFoundError, ValidationError } from "@editorzero/errors";
import { UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability, type Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { workspaceMemberUpdateRole } from "./member_update_role";

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

function buildCtx(workspace_id: WorkspaceId, frozenNow = 1000): CapabilityContext {
  return {
    principal: userPrincipal(workspace_id),
    tenant: { workspace_id },
    db: driver.scoped(workspace_id),
    transact: async () => {
      throw new Error("transact not exercised by workspace.member_update_role (metadata-only)");
    },
    outbox: () => {
      /* member_update_role emits no outbox events */
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

describe("workspace.member_update_role", () => {
  it("promotes a member to admin (happy path)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member" });
    const ctx = buildCtx(WORKSPACE_A, 5000);

    const out = await workspaceMemberUpdateRole.handler(ctx, { user_id: BOB, role: "admin" });
    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      user_id: BOB,
      role: "admin",
      updated_at: 5000,
    });

    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select(["role", "updated_at"])
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("admin");
    expect(row.updated_at).toBe(5000);
  });

  it("demotes a non-last owner to admin", async () => {
    // Two owners — demoting one still leaves a live owner.
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "owner" });
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceMemberUpdateRole.handler(ctx, { user_id: BOB, role: "admin" });
    expect(out.role).toBe("admin");
  });

  it("promotes an admin to owner (no demote, no last-owner check)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "admin" });
    const ctx = buildCtx(WORKSPACE_A);

    const out = await workspaceMemberUpdateRole.handler(ctx, { user_id: BOB, role: "owner" });
    expect(out.role).toBe("owner");
  });

  it("throws LastOwnerError when demoting the only live owner", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(
      workspaceMemberUpdateRole.handler(ctx, { user_id: ALICE, role: "admin" }),
    ).rejects.toBeInstanceOf(LastOwnerError);

    // DB confirms role unchanged — tx atomicity means no write landed.
    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select("role")
      .where("user_id", "=", ALICE)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("owner");
  });

  it("does not count soft-deleted owners toward the live-owner total", async () => {
    // Two owners exist but one is soft-deleted — the live owner is
    // ALICE alone, so demoting her violates the invariant.
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "owner", deleted_at: 999 });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(
      workspaceMemberUpdateRole.handler(ctx, { user_id: ALICE, role: "admin" }),
    ).rejects.toBeInstanceOf(LastOwnerError);
  });

  it("throws NotFoundError when the target has no membership row", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(
      workspaceMemberUpdateRole.handler(ctx, { user_id: BOB, role: "admin" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the target is soft-deleted (no revive-via-update)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member", deleted_at: 500 });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(
      workspaceMemberUpdateRole.handler(ctx, { user_id: BOB, role: "admin" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ValidationError with issue code `role_unchanged` when target already has the asserted role", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member" });
    const ctx = buildCtx(WORKSPACE_A);

    const error = await workspaceMemberUpdateRole
      .handler(ctx, { user_id: BOB, role: "member" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    if (error instanceof ValidationError) {
      const issue = (error.issues as { code: string }[])[0];
      expect(issue?.code).toBe("role_unchanged");
    }
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot mutate workspace-B's members", async () => {
    await seedMember({ workspace_id: WORKSPACE_A, user_id: ALICE, role: "owner" });
    await seedMember({ workspace_id: WORKSPACE_B, user_id: BOB, role: "member" });
    const ctxA = buildCtx(WORKSPACE_A);

    await expect(
      workspaceMemberUpdateRole.handler(ctxA, { user_id: BOB, role: "admin" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select("role")
      .where("workspace_id", "=", WORKSPACE_B)
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("member");
  });

  // ── Input validation rails ──────────────────────────────────────────────

  it("rejects empty user_id", () => {
    const result = workspaceMemberUpdateRole.input.safeParse({ user_id: "", role: "admin" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown role value", () => {
    const result = workspaceMemberUpdateRole.input.safeParse({
      user_id: CAROL,
      role: "bogus",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = workspaceMemberUpdateRole.input.safeParse({
      user_id: CAROL,
      role: "admin",
      extra: 1,
    });
    expect(result.success).toBe(false);
  });

  // ── Metadata-only enrolment ────────────────────────────────────────────

  it("is registered in METADATA_ONLY_CAPABILITIES", () => {
    expect(isMetadataOnlyCapability("workspace.member_update_role")).toBe(true);
  });

  // ── Registry metadata ──────────────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(workspaceMemberUpdateRole.id).toBe("workspace.member_update_role");
    expect(workspaceMemberUpdateRole.category).toBe("mutation");
    expect(workspaceMemberUpdateRole.requires).toEqual(["workspace:admin"]);
    expect(workspaceMemberUpdateRole.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(workspaceMemberUpdateRole.agentAllowed).toEqual({});
  });

  // ── Audit projections ──────────────────────────────────────────────────

  it("projects a user subject carrying the target user_id", () => {
    const subject = workspaceMemberUpdateRole.audit.subjectFrom({
      user_id: BOB,
      role: "admin",
    });
    expect(subject).toEqual({ kind: "user", id: BOB });
  });

  it("emits an allow effect with member.update_role kind + workspace/user/role fields", () => {
    const effect = workspaceMemberUpdateRole.audit.effectOnAllow(
      { user_id: BOB, role: "admin" },
      {
        workspace_id: WORKSPACE_A,
        user_id: BOB,
        role: "admin",
        updated_at: 1234,
      },
    );
    expect(effect.kind).toBe("member.update_role");
    if (effect.kind === "member.update_role") {
      expect(effect.workspace_id).toBe(WORKSPACE_A);
      expect(effect.user_id).toBe(BOB);
      expect(effect.role).toBe("admin");
    }
  });

  it("emits a deny effect carrying the reason code + admin scope requirement", () => {
    const effect = workspaceMemberUpdateRole.audit.effectOnDeny(
      { user_id: BOB, role: "admin" },
      { kind: "missing_scope", required: ["workspace:admin"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("workspace.member_update_role");
      expect(effect.required_scopes).toEqual(["workspace:admin"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on conflict via projectErrorAudit", () => {
    const effect = workspaceMemberUpdateRole.audit.effectOnError(
      { user_id: ALICE, role: "admin" },
      { kind: "conflict" },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("workspace.member_update_role");
      expect(effect.error_code).toBe("conflict");
    }
  });

  it("declares a non-collapsing audit policy (mutations are not collapsed)", () => {
    expect(workspaceMemberUpdateRole.audit.collapsePolicy).toEqual({ collapsible: false });
  });
});
