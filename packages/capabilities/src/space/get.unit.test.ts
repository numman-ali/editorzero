/**
 * `space.get` unit suite — real in-memory SQLite.
 *
 * Pins, in handler order: the 404-first trash-invisible posture, the
 * reach-∨-administer visibility rule across every subject class
 * (open baseline / membership / space grant / admin backstop /
 * personal privacy pin / agent no-baseline), the full row echo,
 * input rails, registry/audit projections.
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
import { AgentId, GrantId, SpaceId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceGet } from "./get";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const MEMBER_CLOSED = UserId("018f0000-0000-7000-8000-0000000000a4");
const SPACE_GRANTEE = UserId("018f0000-0000-7000-8000-0000000000a6");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

const S_OPEN = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const S_PRIVATE = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e5");
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

  await seedSpace(S_OPEN, "open");
  await seedSpace(S_CLOSED, "closed");
  await seedSpace(S_PRIVATE, "private");
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);
  await seedSpace(S_TRASHED, "open", 99);

  await db
    .insertInto("space_members")
    .values({
      workspace_id: WORKSPACE_A,
      space_id: S_CLOSED,
      user_id: MEMBER_CLOSED,
      role: "view",
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await db
    .insertInto("grants")
    .values({
      id: GrantId("018f0000-0000-7000-8000-0000000000f1"),
      workspace_id: WORKSPACE_A,
      resource_kind: "space",
      resource_id: S_PRIVATE,
      subject_kind: "user",
      subject_id: SPACE_GRANTEE,
      role: "view",
      is_guest: 0,
      created_by: CREATOR,
      created_at: 1,
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

function bot(): AgentPrincipal {
  return {
    kind: "agent",
    id: BOT,
    workspace_id: WORKSPACE_A,
    owner_user_id: CREATOR,
    scopes: ["workspace:read"],
    token_id: BOT_TOKEN,
    token_kind: "api-key",
  };
}

function buildCtx(principal: Principal): CapabilityContext {
  return {
    principal,
    tenant: { workspace_id: WORKSPACE_A },
    db,
    transact: async () => {
      throw new Error("read capability must not call ctx.transact");
    },
    outbox: () => {
      /* space.get enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 5000,
  };
}

function getInput(space_id: string = S_OPEN) {
  return spaceGet.input.parse({ space_id });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.get — 404s (trash-invisible read posture)", () => {
  it.each([
    ["missing space", S_MISSING],
    ["archived space (restore first)", S_TRASHED],
  ])("%s → not_found, even for an admin", async (_label, space_id) => {
    const err = await spaceGet
      .handler(buildCtx(user(ADMIN, ["admin"])), getInput(space_id))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
    }
  });
});

describe("space.get — visibility (reach ∨ administer)", () => {
  it.each([
    ["plain member sees an OPEN space (Org baseline)", PLAIN_MEMBER, S_OPEN, true],
    ["plain member does NOT see a closed space", PLAIN_MEMBER, S_CLOSED, false],
    ["plain member does NOT see a private space", PLAIN_MEMBER, S_PRIVATE, false],
    ["plain member does NOT see another's personal space", PLAIN_MEMBER, S_PERSONAL, false],
    ["membership opens a closed space", MEMBER_CLOSED, S_CLOSED, true],
    ["a space grant opens a private space", SPACE_GRANTEE, S_PRIVATE, true],
    ["admin sees a closed team space (administer backstop)", ADMIN, S_CLOSED, true],
    ["admin sees a private team space (administer backstop)", ADMIN, S_PRIVATE, true],
    ["admin does NOT see another's personal space (privacy pin)", ADMIN, S_PERSONAL, false],
    ["the personal owner sees their personal space", PERSONAL_OWNER, S_PERSONAL, true],
  ])("%s", async (_label, caller, space_id, visible) => {
    const roles: readonly Role[] = caller === ADMIN ? ["admin"] : ["member"];
    const result = await spaceGet
      .handler(buildCtx(user(caller, roles)), getInput(space_id))
      .catch((e: unknown) => e);
    if (visible) {
      expect(result).toMatchObject({ space_id });
    } else {
      expect(result).toBeInstanceOf(PermissionDeniedError);
      if (result instanceof PermissionDeniedError) {
        expect(result.reason).toEqual({ kind: "acl_deny", scope: { space_id } });
      }
    }
  });

  it("a non-delegated agent has NO open-space baseline — grants are its only door", async () => {
    const denied = await spaceGet
      .handler(buildCtx(bot()), getInput(S_OPEN))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(PermissionDeniedError);

    await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f2"),
        workspace_id: WORKSPACE_A,
        resource_kind: "space",
        resource_id: S_OPEN,
        subject_kind: "agent",
        subject_id: BOT,
        role: "view",
        is_guest: 0,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();
    const out = await spaceGet.handler(buildCtx(bot()), getInput(S_OPEN));
    expect(out.space_id).toBe(S_OPEN);
  });
});

describe("space.get — application (row echo)", () => {
  it("echoes the full SpaceRowOutput shape", async () => {
    const out = await spaceGet.handler(buildCtx(user(PLAIN_MEMBER)), getInput(S_OPEN));
    expect(out).toEqual({
      space_id: S_OPEN,
      workspace_id: WORKSPACE_A,
      kind: "team",
      type: "open",
      owner_user_id: null,
      name: "space-e1",
      slug: "space-e1",
      baseline_access: "view",
      created_by: CREATOR,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    });
  });

  it("a personal row carries its structural owner", async () => {
    const out = await spaceGet.handler(buildCtx(user(PERSONAL_OWNER)), getInput(S_PERSONAL));
    expect(out.kind).toBe("personal");
    expect(out.owner_user_id).toBe(PERSONAL_OWNER);
  });
});

describe("space.get — input rails", () => {
  it.each([
    ["malformed space_id", { space_id: "not-a-uuid" }],
    ["unknown key", { space_id: S_OPEN, include_trashed: true }],
    ["missing space_id", {}],
  ])("%s → schema rejects", (_label, raw) => {
    expect(() => spaceGet.input.parse(raw)).toThrow();
  });
});

describe("space.get — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceGet.id).toBe("space.get");
    expect(spaceGet.category).toBe("read");
    expect(spaceGet.requires).toEqual(["workspace:read"]);
    expect(spaceGet.surfaces).toEqual(["api", "cli", "mcp"]);
  });

  it("projects the space as the audit subject and logs an access row", async () => {
    expect(spaceGet.audit.subjectFrom(getInput())).toEqual({ kind: "space", id: S_OPEN });
    const out = await spaceGet.handler(buildCtx(user(PLAIN_MEMBER)), getInput(S_OPEN));
    expect(spaceGet.audit.effectOnAllow(getInput(S_OPEN), out)).toEqual({
      kind: "audit.access_log",
    });
  });

  it("collapses per-space (distinct spaces are distinct buckets)", () => {
    const policy = spaceGet.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(policy.collapseKey(getInput(S_OPEN))).toBe(`space.get:${S_OPEN}`);
      expect(policy.collapseKey(getInput(S_CLOSED))).not.toBe(policy.collapseKey(getInput(S_OPEN)));
    }
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceGet.audit.effectOnDeny(getInput(), {
      kind: "missing_scope",
      required: ["workspace:read"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.get",
      required_scopes: ["workspace:read"],
      reason_code: "missing_scope",
    });
  });
});
