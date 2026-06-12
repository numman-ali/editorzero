/**
 * `space.member_add` unit suite — real in-memory SQLite.
 *
 * Pins, in handler order: 404-first trash posture, the
 * `assertCanAdministerSpace` wiring (full matrix in
 * `acl/ceiling.unit.test.ts`), the personal-roster refusal (AFTER
 * authority — kind not leaked), the subject-standing rule (live
 * workspace membership), the duplicate-row 409 (no revive branch — the
 * table is hard-DELETE), the fresh-INSERT echo, registry/audit
 * projections.
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
  WORKSPACE_MEMBERS_DDL,
} from "@editorzero/db";
import {
  MemberAlreadyExistsError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@editorzero/errors";
import { GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceMemberAdd } from "./member_add";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const GRANT_OWNER = UserId("018f0000-0000-7000-8000-0000000000a5");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");
const TARGET = UserId("018f0000-0000-7000-8000-0000000000b1");
const OFFBOARDED = UserId("018f0000-0000-7000-8000-0000000000b2");
const STRANGER = UserId("018f0000-0000-7000-8000-0000000000b9");

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
  driver.exec(WORKSPACE_MEMBERS_DDL);
  db = driver.scoped(WORKSPACE_A);

  await seedSpace(S_TEAM, "closed");
  await seedSpace(S_TRASHED, "open", 99);
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);

  // Subject-standing fixtures: TARGET + PLAIN_MEMBER live, OFFBOARDED
  // soft-deleted, STRANGER absent entirely.
  await seedWorkspaceMember(TARGET);
  await seedWorkspaceMember(PLAIN_MEMBER);
  await seedWorkspaceMember(OFFBOARDED, 50);
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

async function seedWorkspaceMember(user_id: UserId, deleted_at: number | null = null) {
  await db
    .insertInto("workspace_members")
    .values({
      workspace_id: WORKSPACE_A,
      user_id,
      role: "member",
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
      /* space.member_add enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function addInput(over: { space_id?: string; user_id?: string; role?: string } = {}) {
  return spaceMemberAdd.input.parse({
    space_id: over.space_id ?? S_TEAM,
    user_id: over.user_id ?? TARGET,
    role: over.role ?? "view",
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.member_add — 404s (trash-invisible)", () => {
  it.each([
    ["missing space", S_MISSING],
    ["already-trashed space", S_TRASHED],
  ])("%s → not_found before authority", async (_label, space_id) => {
    const err = await spaceMemberAdd
      .handler(buildCtx(user(ADMIN, ["admin"])), addInput({ space_id }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
    }
  });
});

describe("space.member_add — authority (ladder wiring)", () => {
  it("plain member → acl_deny scoped to the space", async () => {
    const err = await spaceMemberAdd
      .handler(buildCtx(user(PLAIN_MEMBER)), addInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_TEAM } });
    }
  });

  it("workspace admin (backstop) adds a member to a team space", async () => {
    const out = await spaceMemberAdd.handler(buildCtx(user(ADMIN, ["admin"]), 9000), addInput());
    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      space_id: S_TEAM,
      user_id: TARGET,
      role: "view",
      created_at: 9000,
      updated_at: 9000,
    });
  });

  it("non-guest owner-grant holder adds (space owner-tier)", async () => {
    await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f1"),
        workspace_id: WORKSPACE_A,
        resource_kind: "space",
        resource_id: S_TEAM,
        subject_kind: "user",
        subject_id: GRANT_OWNER,
        role: "owner",
        is_guest: 0,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();
    const out = await spaceMemberAdd.handler(buildCtx(user(GRANT_OWNER)), addInput());
    expect(out.user_id).toBe(TARGET);
  });
});

describe("space.member_add — personal spaces hold no roster", () => {
  it("the owner (who passes the ladder) is refused with the pinned code", async () => {
    const err = await spaceMemberAdd
      .handler(buildCtx(user(PERSONAL_OWNER)), addInput({ space_id: S_PERSONAL }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("personal_space_membership_pinned");
    }
    const rows = await db.selectFrom("space_members").select(["user_id"]).execute();
    expect(rows).toHaveLength(0);
  });

  it("authority still runs FIRST: a workspace admin gets acl_deny, not the personal refusal (kind not leaked)", async () => {
    const err = await spaceMemberAdd
      .handler(buildCtx(user(ADMIN, ["admin"])), addInput({ space_id: S_PERSONAL }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
  });
});

describe("space.member_add — subject standing (live workspace membership)", () => {
  it.each([
    ["no workspace membership at all", STRANGER],
    ["soft-deleted workspace membership", OFFBOARDED],
  ])("%s → subject_not_workspace_member, nothing written", async (_label, user_id) => {
    const err = await spaceMemberAdd
      .handler(buildCtx(user(ADMIN, ["admin"])), addInput({ user_id }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("subject_not_workspace_member");
    }
    const rows = await db.selectFrom("space_members").select(["user_id"]).execute();
    expect(rows).toHaveLength(0);
  });
});

describe("space.member_add — duplicate roster entry", () => {
  it("existing row → member_already_exists carrying the space context; nothing written", async () => {
    await spaceMemberAdd.handler(buildCtx(user(ADMIN, ["admin"])), addInput());

    const err = await spaceMemberAdd
      .handler(buildCtx(user(ADMIN, ["admin"])), addInput({ role: "edit" }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemberAlreadyExistsError);
    if (err instanceof MemberAlreadyExistsError) {
      expect(err.space_id).toBe(S_TEAM);
      expect(err.user_id).toBe(TARGET);
      expect(err.code).toBe("member_already_exists");
    }

    // The role-change attempt did not clobber the existing row.
    const row = await db
      .selectFrom("space_members")
      .select(["role"])
      .where("space_id", "=", S_TEAM)
      .where("user_id", "=", TARGET)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("view");
  });
});

describe("space.member_add — application", () => {
  it("inserts the row with the handler clock on both timestamps", async () => {
    await spaceMemberAdd.handler(
      buildCtx(user(ADMIN, ["admin"]), 9000),
      addInput({ role: "owner" }),
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
      created_at: 9000,
      updated_at: 9000,
    });
  });

  it("the minted owner-role membership IS administer standing (the ladder reads it)", async () => {
    await spaceMemberAdd.handler(buildCtx(user(ADMIN, ["admin"])), addInput({ role: "owner" }));
    // TARGET (a plain member principal) can now administer the roster.
    const out = await spaceMemberAdd.handler(
      buildCtx(user(TARGET)),
      addInput({ user_id: PLAIN_MEMBER }),
    );
    expect(out.user_id).toBe(PLAIN_MEMBER);
  });
});

describe("space.member_add — input rails", () => {
  it.each([
    ["malformed space_id", { space_id: "not-a-uuid", user_id: TARGET, role: "view" }],
    ["empty user_id", { space_id: S_TEAM, user_id: "", role: "view" }],
    ["workspace ROLES vocabulary rejected", { space_id: S_TEAM, user_id: TARGET, role: "admin" }],
    ["unknown key", { space_id: S_TEAM, user_id: TARGET, role: "view", is_guest: true }],
  ])("%s → schema rejects", (_label, raw) => {
    expect(() => spaceMemberAdd.input.parse(raw)).toThrow();
  });
});

describe("space.member_add — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceMemberAdd.id).toBe("space.member_add");
    expect(spaceMemberAdd.category).toBe("mutation");
    expect(spaceMemberAdd.requires).toEqual(["space:manage"]);
    expect(spaceMemberAdd.agentAllowed).toEqual({});
    expect(spaceMemberAdd.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(spaceMemberAdd.audit.collapsePolicy).toEqual({ collapsible: false });
  });

  it("projects the target user as the audit subject", () => {
    expect(spaceMemberAdd.audit.subjectFrom(addInput())).toEqual({
      kind: "user",
      id: TARGET,
    });
  });

  it("emits space.member_add carrying the full row identity", async () => {
    const input = addInput({ role: "comment" });
    const out = await spaceMemberAdd.handler(buildCtx(user(ADMIN, ["admin"])), input);
    expect(spaceMemberAdd.audit.effectOnAllow(input, out)).toEqual({
      kind: "space.member_add",
      workspace_id: WORKSPACE_A,
      space_id: S_TEAM,
      user_id: TARGET,
      role: "comment",
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceMemberAdd.audit.effectOnDeny(addInput(), {
      kind: "missing_scope",
      required: ["space:manage"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.member_add",
      required_scopes: ["space:manage"],
      reason_code: "missing_scope",
    });
  });
});
