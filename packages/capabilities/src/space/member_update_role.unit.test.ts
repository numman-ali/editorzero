/**
 * `space.member_update_role` unit suite — real in-memory SQLite.
 *
 * Pins, in handler order: 404-first trash posture (space, then the
 * roster row), the `assertCanAdministerSpace` wiring, the
 * `role_unchanged` no-op rejection, the optimistic-predicate UPDATE +
 * echo, registry/audit projections.
 */

import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  DOCS_DDL,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import { NotFoundError, PermissionDeniedError, ValidationError } from "@editorzero/errors";
import { SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceMemberUpdateRole } from "./member_update_role";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");
const TARGET = UserId("018f0000-0000-7000-8000-0000000000b1");

const S_TEAM = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_MISSING = SpaceId("018f0000-0000-7000-8000-0000000000e9");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  driver.exec(DOCS_DDL);
  db = driver.scoped(WORKSPACE_A);

  await seedSpace(S_TEAM, "closed");
  await seedSpace(S_TRASHED, "open", 99);
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);
  await db
    .insertInto("space_members")
    .values({
      workspace_id: WORKSPACE_A,
      space_id: S_TEAM,
      user_id: TARGET,
      role: "view",
      created_at: 1,
      updated_at: 1,
    })
    .execute();
});

afterEach(async () => {
  await driver.close();
});

async function seedSpace(
  id: SpaceId,
  type: "open" | "closed" | "private",
  deleted_at: number | null = null,
  personalOwner: UserId | null = null,
) {
  await db
    .insertInto("spaces")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      kind: personalOwner === null ? "team" : "personal",
      type,
      owner_user_id: personalOwner,
      name: `space-${id.slice(-2)}`,
      slug: `space-${id.slice(-2)}`,
      baseline_access: "view",
      created_by: CREATOR,
      created_at: 1,
      updated_at: 1,
      deleted_at,
    })
    .execute();
}

function user(id: UserId, roles: readonly Role[] = ["member"]): UserPrincipal {
  return { kind: "user", id, workspace_id: WORKSPACE_A, roles, session_id: null, token_id: null };
}

function buildCtx(principal: Principal, frozenNow = 5000): CapabilityContext {
  return {
    principal,
    tenant: { workspace_id: WORKSPACE_A },
    db,
    transact: async () => {
      throw new Error("metadata-only capability must not call ctx.transact");
    },
    outbox: () => {
      /* space.member_update_role enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function updateInput(over: { space_id?: string; user_id?: string; role?: string } = {}) {
  return spaceMemberUpdateRole.input.parse({
    space_id: over.space_id ?? S_TEAM,
    user_id: over.user_id ?? TARGET,
    role: over.role ?? "edit",
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.member_update_role — 404s", () => {
  it.each([
    ["missing space", S_MISSING],
    ["already-trashed space (roster not editable in the trash)", S_TRASHED],
  ])("%s → not_found on the space, before authority", async (_label, space_id) => {
    const err = await spaceMemberUpdateRole
      .handler(buildCtx(user(ADMIN, ["admin"])), updateInput({ space_id }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
    }
  });

  it("target not on the roster → not_found on the USER", async () => {
    const err = await spaceMemberUpdateRole
      .handler(buildCtx(user(ADMIN, ["admin"])), updateInput({ user_id: PLAIN_MEMBER }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("user");
      expect(err.subject_id).toBe(PLAIN_MEMBER);
    }
  });
});

describe("space.member_update_role — authority (ladder wiring)", () => {
  it("plain member → acl_deny scoped to the space", async () => {
    const err = await spaceMemberUpdateRole
      .handler(buildCtx(user(PLAIN_MEMBER)), updateInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_TEAM } });
    }
  });

  it("workspace admin (backstop) updates the role", async () => {
    const out = await spaceMemberUpdateRole.handler(
      buildCtx(user(ADMIN, ["admin"]), 9000),
      updateInput(),
    );
    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      space_id: S_TEAM,
      user_id: TARGET,
      role: "edit",
      updated_at: 9000,
    });
  });
});

describe("space.member_update_role — personal refusal (Step-8 slice-2 Codex review SHOULD-FIX)", () => {
  it("a corrupt personal roster row is NOT editable — refuse after authority; remove stays the repair verb", async () => {
    // Constructible only out-of-band (member_add refuses personal);
    // mutating its role would treat corruption as steady state.
    await db
      .insertInto("space_members")
      .values({
        workspace_id: WORKSPACE_A,
        space_id: S_PERSONAL,
        user_id: PLAIN_MEMBER,
        role: "view",
        created_at: 1,
        updated_at: 1,
      })
      .execute();
    const err = await spaceMemberUpdateRole
      .handler(
        buildCtx(user(PERSONAL_OWNER)),
        updateInput({ space_id: S_PERSONAL, user_id: PLAIN_MEMBER }),
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("personal_space_membership_pinned");
    }
    const row = await db
      .selectFrom("space_members")
      .select(["role"])
      .where("space_id", "=", S_PERSONAL)
      .where("user_id", "=", PLAIN_MEMBER)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("view");
  });

  it("the refusal sits AFTER authority — an outsider still sees acl_deny, not the kind", async () => {
    const err = await spaceMemberUpdateRole
      .handler(
        buildCtx(user(PLAIN_MEMBER)),
        updateInput({ space_id: S_PERSONAL, user_id: PLAIN_MEMBER }),
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_PERSONAL } });
    }
  });
});

describe("space.member_update_role — no-op rejection", () => {
  it("re-asserting the current role → role_unchanged, nothing mutated", async () => {
    const err = await spaceMemberUpdateRole
      .handler(buildCtx(user(ADMIN, ["admin"])), updateInput({ role: "view" }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("role_unchanged");
    }
    const row = await db
      .selectFrom("space_members")
      .select(["role", "updated_at"])
      .where("space_id", "=", S_TEAM)
      .where("user_id", "=", TARGET)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ role: "view", updated_at: 1 });
  });
});

describe("space.member_update_role — application", () => {
  it("updates the role, bumps updated_at, preserves created_at", async () => {
    await spaceMemberUpdateRole.handler(
      buildCtx(user(ADMIN, ["admin"]), 9000),
      updateInput({ role: "owner" }),
    );
    const row = await db
      .selectFrom("space_members")
      .selectAll()
      .where("space_id", "=", S_TEAM)
      .where("user_id", "=", TARGET)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      workspace_id: WORKSPACE_A,
      space_id: S_TEAM,
      user_id: TARGET,
      role: "owner",
      created_at: 1,
      updated_at: 9000,
    });
  });

  it("an owner-role promotion confers administer standing (the ladder reads the roster)", async () => {
    await spaceMemberUpdateRole.handler(
      buildCtx(user(ADMIN, ["admin"])),
      updateInput({ role: "owner" }),
    );
    // TARGET (plain member principal) can now run roster mutations.
    const out = await spaceMemberUpdateRole.handler(
      buildCtx(user(TARGET), 9500),
      updateInput({ role: "comment" }),
    );
    expect(out.role).toBe("comment");
  });
});

describe("space.member_update_role — input rails", () => {
  it.each([
    ["malformed space_id", { space_id: "not-a-uuid", user_id: TARGET, role: "edit" }],
    ["empty user_id", { space_id: S_TEAM, user_id: "", role: "edit" }],
    ["workspace ROLES vocabulary rejected", { space_id: S_TEAM, user_id: TARGET, role: "member" }],
    ["unknown key", { space_id: S_TEAM, user_id: TARGET, role: "edit", reason: "promo" }],
  ])("%s → schema rejects", (_label, raw) => {
    expect(() => spaceMemberUpdateRole.input.parse(raw)).toThrow();
  });
});

describe("space.member_update_role — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceMemberUpdateRole.id).toBe("space.member_update_role");
    expect(spaceMemberUpdateRole.category).toBe("mutation");
    expect(spaceMemberUpdateRole.requires).toEqual(["space:manage"]);
    expect(spaceMemberUpdateRole.agentAllowed).toEqual({});
    expect(spaceMemberUpdateRole.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(spaceMemberUpdateRole.audit.collapsePolicy).toEqual({ collapsible: false });
  });

  it("projects the target user as the audit subject", () => {
    expect(spaceMemberUpdateRole.audit.subjectFrom(updateInput())).toEqual({
      kind: "user",
      id: TARGET,
    });
  });

  it("emits space.member_update_role carrying the post-state role", async () => {
    const input = updateInput({ role: "comment" });
    const out = await spaceMemberUpdateRole.handler(buildCtx(user(ADMIN, ["admin"])), input);
    expect(spaceMemberUpdateRole.audit.effectOnAllow(input, out)).toEqual({
      kind: "space.member_update_role",
      space_id: S_TEAM,
      user_id: TARGET,
      role: "comment",
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceMemberUpdateRole.audit.effectOnDeny(updateInput(), {
      kind: "missing_scope",
      required: ["space:manage"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.member_update_role",
      required_scopes: ["space:manage"],
      reason_code: "missing_scope",
    });
  });
});
