/**
 * `space.list` unit suite — real in-memory SQLite.
 *
 * Pins: the per-row reach-∨-administer filter across subject classes
 * (the `space.get` rule applied as a filter), the personal privacy pin
 * surviving the admin backstop, trash exclusion, the deterministic
 * `name ASC, id ASC` ordering, input rails, registry/audit
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
} from "@editorzero/db";
import { AgentId, GrantId, SpaceId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceList } from "./list";

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

// Ids chosen so the `space-<suffix>` names sort: e1 < e2 < e3 < e4.
const S_OPEN = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const S_PRIVATE = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e5");

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
  name = `space-${id.slice(-2)}`,
) {
  await db
    .insertInto("spaces")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      kind: personalOwner === null ? "team" : "personal",
      type,
      owner_user_id: personalOwner,
      name,
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
      /* space.list enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 5000,
  };
}

async function visibleIds(principal: Principal): Promise<readonly string[]> {
  const out = await spaceList.handler(buildCtx(principal), spaceList.input.parse({}));
  return out.spaces.map((s) => s.space_id);
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.list — the per-row visibility filter", () => {
  it("plain member: open spaces only (the Org baseline)", async () => {
    expect(await visibleIds(user(PLAIN_MEMBER))).toEqual([S_OPEN]);
  });

  it("membership adds the closed space", async () => {
    expect(await visibleIds(user(MEMBER_CLOSED))).toEqual([S_OPEN, S_CLOSED]);
  });

  it("a space grant adds the private space", async () => {
    expect(await visibleIds(user(SPACE_GRANTEE))).toEqual([S_OPEN, S_PRIVATE]);
  });

  it("admin: every team space (administer backstop) but NOT another's personal (privacy pin)", async () => {
    expect(await visibleIds(user(ADMIN, ["admin"]))).toEqual([S_OPEN, S_CLOSED, S_PRIVATE]);
  });

  it("the personal owner sees their personal space alongside the open baseline", async () => {
    expect(await visibleIds(user(PERSONAL_OWNER))).toEqual([S_OPEN, S_PERSONAL]);
  });

  it("a non-delegated agent has NO baseline — empty until granted", async () => {
    expect(await visibleIds(bot())).toEqual([]);

    await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f2"),
        workspace_id: WORKSPACE_A,
        resource_kind: "space",
        resource_id: S_CLOSED,
        subject_kind: "agent",
        subject_id: BOT,
        role: "view",
        is_guest: 0,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();
    expect(await visibleIds(bot())).toEqual([S_CLOSED]);
  });

  it("trashed spaces never appear — even for an admin", async () => {
    const ids = await visibleIds(user(ADMIN, ["admin"]));
    expect(ids).not.toContain(S_TRASHED);
  });
});

describe("space.list — ordering (name ASC, id ASC)", () => {
  it("orders by name, with id as the duplicate-name tiebreak", async () => {
    // Two more open spaces: one named to sort FIRST, one a duplicate
    // of an existing name so the id tiebreak is observable.
    const S_AARDVARK = SpaceId("018f0000-0000-7000-8000-0000000000e7");
    const S_DUP = SpaceId("018f0000-0000-7000-8000-0000000000e8");
    await seedSpace(S_AARDVARK, "open", null, null, "aaa-first");
    await seedSpace(S_DUP, "open", null, null, "space-e1");

    expect(await visibleIds(user(PLAIN_MEMBER))).toEqual([S_AARDVARK, S_OPEN, S_DUP]);
  });
});

describe("space.list — input rails", () => {
  it("unknown keys are rejected (strict empty input)", () => {
    expect(() => spaceList.input.parse({ include_trashed: true })).toThrow();
  });
});

describe("space.list — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceList.id).toBe("space.list");
    expect(spaceList.category).toBe("read");
    expect(spaceList.requires).toEqual(["workspace:read"]);
    expect(spaceList.surfaces).toEqual(["api", "cli", "mcp"]);
  });

  it("pivots the audit subject on the workspace and logs an access row", async () => {
    expect(spaceList.audit.subjectFrom(spaceList.input.parse({}))).toEqual({ kind: "workspace" });
    const out = await spaceList.handler(buildCtx(user(PLAIN_MEMBER)), spaceList.input.parse({}));
    expect(spaceList.audit.effectOnAllow(spaceList.input.parse({}), out)).toEqual({
      kind: "audit.access_log",
    });
  });

  it("collapses on a constant bucket (no input to vary on)", () => {
    const policy = spaceList.audit.collapsePolicy;
    expect(policy.collapsible).toBe(true);
    if (policy.collapsible) {
      expect(policy.collapseKey(spaceList.input.parse({}))).toBe("space.list");
    }
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceList.audit.effectOnDeny(spaceList.input.parse({}), {
      kind: "missing_scope",
      required: ["workspace:read"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.list",
      required_scopes: ["workspace:read"],
      reason_code: "missing_scope",
    });
  });
});
