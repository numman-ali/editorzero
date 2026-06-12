/**
 * `space.member_remove` unit suite — real in-memory SQLite.
 *
 * Pins, in handler order: 404-first trash posture (space, then the
 * roster row), the `assertCanAdministerSpace` wiring, the hard-DELETE
 * + full-preimage echo, the repair-verb honesty on personal spaces,
 * doc grants surviving removal, registry/audit projections.
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
import { NotFoundError, PermissionDeniedError } from "@editorzero/errors";
import { GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceMemberRemove } from "./member_remove";

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
  await seedRosterRow(S_TEAM, TARGET, "edit");
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

async function seedRosterRow(
  space_id: SpaceId,
  user_id: UserId,
  role: "owner" | "edit" | "comment" | "view",
) {
  await db
    .insertInto("space_members")
    .values({
      workspace_id: WORKSPACE_A,
      space_id,
      user_id,
      role,
      created_at: 1,
      updated_at: 1,
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
      /* space.member_remove enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function removeInput(over: { space_id?: string; user_id?: string } = {}) {
  return spaceMemberRemove.input.parse({
    space_id: over.space_id ?? S_TEAM,
    user_id: over.user_id ?? TARGET,
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.member_remove — 404s", () => {
  it.each([
    ["missing space", S_MISSING],
    ["already-trashed space (roster not editable in the trash)", S_TRASHED],
  ])("%s → not_found on the space, before authority", async (_label, space_id) => {
    const err = await spaceMemberRemove
      .handler(buildCtx(user(ADMIN, ["admin"])), removeInput({ space_id }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
    }
  });

  it("target not on the roster → not_found on the USER (stale-view signal, not idempotent)", async () => {
    const err = await spaceMemberRemove
      .handler(buildCtx(user(ADMIN, ["admin"])), removeInput({ user_id: PLAIN_MEMBER }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("user");
      expect(err.subject_id).toBe(PLAIN_MEMBER);
    }
  });
});

describe("space.member_remove — authority (ladder wiring)", () => {
  it("plain member → acl_deny scoped to the space", async () => {
    const err = await spaceMemberRemove
      .handler(buildCtx(user(PLAIN_MEMBER)), removeInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_TEAM } });
    }
  });

  it("an owner-role MEMBER administers their own roster (membership rung of the ladder)", async () => {
    await seedRosterRow(S_TEAM, PLAIN_MEMBER, "owner");
    const out = await spaceMemberRemove.handler(buildCtx(user(PLAIN_MEMBER)), removeInput());
    expect(out.user_id).toBe(TARGET);
  });

  it("self-removal: the last owner-role member can leave — the admin backstop still administers", async () => {
    await seedRosterRow(S_TEAM, PLAIN_MEMBER, "owner");
    const out = await spaceMemberRemove.handler(
      buildCtx(user(PLAIN_MEMBER)),
      removeInput({ user_id: PLAIN_MEMBER }),
    );
    expect(out.user_id).toBe(PLAIN_MEMBER);
    // No last-owner guard by design: the workspace-admin backstop is
    // structural, so an owner-less team space strands nothing.
    const remaining = await spaceMemberRemove.handler(
      buildCtx(user(ADMIN, ["admin"])),
      removeInput(),
    );
    expect(remaining.user_id).toBe(TARGET);
  });
});

describe("space.member_remove — application (hard delete, preimage echo)", () => {
  it("DELETE returns the full preimage and the row is gone", async () => {
    const out = await spaceMemberRemove.handler(buildCtx(user(ADMIN, ["admin"])), removeInput());
    expect(out).toEqual({
      workspace_id: WORKSPACE_A,
      space_id: S_TEAM,
      user_id: TARGET,
      role: "edit",
    });
    const rows = await db
      .selectFrom("space_members")
      .select(["user_id"])
      .where("space_id", "=", S_TEAM)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it("a corrupt roster row on a PERSONAL space: the owner removes it (remove is the repair verb)", async () => {
    // Constructible only out-of-band (member_add refuses personal) —
    // remove deliberately carries no kind refusal so the corruption
    // stays fixable.
    await seedRosterRow(S_PERSONAL, PLAIN_MEMBER, "view");
    const out = await spaceMemberRemove.handler(
      buildCtx(user(PERSONAL_OWNER)),
      removeInput({ space_id: S_PERSONAL, user_id: PLAIN_MEMBER }),
    );
    expect(out.role).toBe("view");
  });

  it("doc grants the member holds survive the removal (H1 — revocation is explicit)", async () => {
    await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f3"),
        workspace_id: WORKSPACE_A,
        resource_kind: "doc",
        resource_id: "018f0000-0000-7000-8000-0000000000d1",
        subject_kind: "user",
        subject_id: TARGET,
        role: "edit",
        is_guest: 0,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();
    await spaceMemberRemove.handler(buildCtx(user(ADMIN, ["admin"])), removeInput());
    const grants = await db.selectFrom("grants").select(["id"]).execute();
    expect(grants).toHaveLength(1);
  });
});

describe("space.member_remove — input rails", () => {
  it.each([
    ["malformed space_id", { space_id: "not-a-uuid", user_id: TARGET }],
    ["empty user_id", { space_id: S_TEAM, user_id: "" }],
    ["unknown key", { space_id: S_TEAM, user_id: TARGET, purge: true }],
  ])("%s → schema rejects", (_label, raw) => {
    expect(() => spaceMemberRemove.input.parse(raw)).toThrow();
  });
});

describe("space.member_remove — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceMemberRemove.id).toBe("space.member_remove");
    expect(spaceMemberRemove.category).toBe("mutation");
    expect(spaceMemberRemove.requires).toEqual(["space:manage"]);
    expect(spaceMemberRemove.agentAllowed).toEqual({});
    expect(spaceMemberRemove.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(spaceMemberRemove.audit.collapsePolicy).toEqual({ collapsible: false });
  });

  it("projects the target user as the audit subject", () => {
    expect(spaceMemberRemove.audit.subjectFrom(removeInput())).toEqual({
      kind: "user",
      id: TARGET,
    });
  });

  it("emits space.member_remove carrying the FULL preimage (workspace_id + removed role)", async () => {
    const input = removeInput();
    const out = await spaceMemberRemove.handler(buildCtx(user(ADMIN, ["admin"])), input);
    expect(spaceMemberRemove.audit.effectOnAllow(input, out)).toEqual({
      kind: "space.member_remove",
      workspace_id: WORKSPACE_A,
      space_id: S_TEAM,
      user_id: TARGET,
      role: "edit",
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceMemberRemove.audit.effectOnDeny(removeInput(), {
      kind: "missing_scope",
      required: ["space:manage"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.member_remove",
      required_scopes: ["space:manage"],
      reason_code: "missing_scope",
    });
  });
});
