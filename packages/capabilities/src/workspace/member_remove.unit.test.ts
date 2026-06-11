/**
 * `workspace.member_remove` — capability-level integration test.
 *
 * Runs the handler against real in-memory SQLite. Exercises the 404
 * (missing or already-removed target), 409 (last-owner invariant),
 * self-removal allowed, and Layer-2 tenant scoping. The last-owner
 * check is atomic with the UPDATE (same write-path tx — `ctx.db` is
 * tx-bound for metadata-only capabilities); here we exercise the
 * static outcome and leave race coverage to an integration suite
 * with real concurrency.
 */

import { createSqliteDriver, type SqliteDriver, WORKSPACE_MEMBERS_DDL } from "@editorzero/db";
import { LastOwnerError, NotFoundError } from "@editorzero/errors";
import { UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability, type Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { workspaceMemberRemove } from "./member_remove";

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
      throw new Error("transact not exercised by workspace.member_remove (metadata-only)");
    },
    outbox: () => {
      /* member_remove emits no outbox events */
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

describe("workspace.member_remove", () => {
  it("soft-deletes an active non-owner member (happy path)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member" });
    const ctx = buildCtx(WORKSPACE_A, 7000);

    const out = await workspaceMemberRemove.handler(ctx, { user_id: BOB });
    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      user_id: BOB,
      deleted_at: 7000,
    });

    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select(["deleted_at", "updated_at"])
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBe(7000);
    expect(row.updated_at).toBe(7000);
  });

  it("removes a non-last owner (leaves another live owner)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "owner" });
    const ctx = buildCtx(WORKSPACE_A, 8000);

    const out = await workspaceMemberRemove.handler(ctx, { user_id: BOB });
    expect(out.deleted_at).toBe(8000);
  });

  it("throws LastOwnerError when removing the only live owner", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(workspaceMemberRemove.handler(ctx, { user_id: ALICE })).rejects.toBeInstanceOf(
      LastOwnerError,
    );

    // DB confirms no write landed — tx atomicity.
    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select("deleted_at")
      .where("user_id", "=", ALICE)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
  });

  it("does not count soft-deleted owners toward the live-owner total (blocks self-removal of last live owner)", async () => {
    // ALICE is live owner; BOB was an owner but is soft-deleted.
    // Live owner count = 1, so removing ALICE violates the invariant.
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "owner", deleted_at: 999 });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(workspaceMemberRemove.handler(ctx, { user_id: ALICE })).rejects.toBeInstanceOf(
      LastOwnerError,
    );
  });

  it("allows self-removal for a non-owner (voluntary leave)", async () => {
    // CAROL is a member; she removes herself.
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: CAROL, role: "member" });
    const ctx = buildCtx(WORKSPACE_A, 9000, CAROL);

    const out = await workspaceMemberRemove.handler(ctx, { user_id: CAROL });
    expect(out.deleted_at).toBe(9000);
  });

  it("throws NotFoundError when the target has no membership row (never-member)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(workspaceMemberRemove.handler(ctx, { user_id: BOB })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws NotFoundError on re-remove (already soft-deleted — not idempotent)", async () => {
    await seedMember({ user_id: ALICE, role: "owner" });
    await seedMember({ user_id: BOB, role: "member", deleted_at: 500 });
    const ctx = buildCtx(WORKSPACE_A);

    await expect(workspaceMemberRemove.handler(ctx, { user_id: BOB })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("composes with Layer-2 scoping: workspace-A ctx cannot remove workspace-B's members", async () => {
    await seedMember({ workspace_id: WORKSPACE_A, user_id: ALICE, role: "owner" });
    await seedMember({ workspace_id: WORKSPACE_B, user_id: BOB, role: "member" });
    const ctxA = buildCtx(WORKSPACE_A);

    await expect(workspaceMemberRemove.handler(ctxA, { user_id: BOB })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const row = await driver
      .system()
      .selectFrom("workspace_members")
      .select("deleted_at")
      .where("workspace_id", "=", WORKSPACE_B)
      .where("user_id", "=", BOB)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
  });

  // ── Input validation rails ──────────────────────────────────────────────

  it("rejects empty user_id", () => {
    const result = workspaceMemberRemove.input.safeParse({ user_id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = workspaceMemberRemove.input.safeParse({ user_id: CAROL, extra: 1 });
    expect(result.success).toBe(false);
  });

  // ── Metadata-only enrolment ────────────────────────────────────────────

  it("is registered in METADATA_ONLY_CAPABILITIES", () => {
    expect(isMetadataOnlyCapability("workspace.member_remove")).toBe(true);
  });

  // ── Registry metadata ──────────────────────────────────────────────────

  it("declares the correct registry metadata", () => {
    expect(workspaceMemberRemove.id).toBe("workspace.member_remove");
    expect(workspaceMemberRemove.category).toBe("mutation");
    expect(workspaceMemberRemove.requires).toEqual(["workspace:admin"]);
    expect(workspaceMemberRemove.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(workspaceMemberRemove.agentAllowed).toEqual({});
  });

  // ── Audit projections ──────────────────────────────────────────────────

  it("projects a user subject carrying the target user_id", () => {
    const subject = workspaceMemberRemove.audit.subjectFrom({ user_id: BOB });
    expect(subject).toEqual({ kind: "user", id: BOB });
  });

  it("emits an allow effect with member.remove kind + workspace/user/deleted_at fields", () => {
    // The effect carries the handler's `deleted_at` so replay reconstructs the
    // membership soft-delete timestamp precisely (Codex review HIGH 4).
    const effect = workspaceMemberRemove.audit.effectOnAllow(
      { user_id: BOB },
      { workspace_id: WORKSPACE_A, user_id: BOB, deleted_at: 7000 },
    );
    expect(effect.kind).toBe("member.remove");
    if (effect.kind === "member.remove") {
      expect(effect.workspace_id).toBe(WORKSPACE_A);
      expect(effect.user_id).toBe(BOB);
      expect(effect.deleted_at).toBe(7000);
    }
  });

  it("emits a deny effect carrying the reason code + admin scope requirement", () => {
    const effect = workspaceMemberRemove.audit.effectOnDeny(
      { user_id: BOB },
      { kind: "missing_scope", required: ["workspace:admin"], principal_scopes: [] },
    );
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.capability).toBe("workspace.member_remove");
      expect(effect.required_scopes).toEqual(["workspace:admin"]);
      expect(effect.reason_code).toBe("missing_scope");
    }
  });

  it("preserves HandlerError kind on conflict via projectErrorAudit", () => {
    const effect = workspaceMemberRemove.audit.effectOnError(
      { user_id: ALICE },
      { kind: "conflict" },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("workspace.member_remove");
      expect(effect.error_code).toBe("conflict");
    }
  });

  it("declares a non-collapsing audit policy (mutations are not collapsed)", () => {
    expect(workspaceMemberRemove.audit.collapsePolicy).toEqual({ collapsible: false });
  });
});
