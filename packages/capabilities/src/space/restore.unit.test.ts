/**
 * `space.restore` unit suite — real in-memory SQLite.
 *
 * Pins, in handler order: 404 on missing/LIVE (restore acts on trash
 * only), the `assertCanRestoreSpace` dead-row ladder wiring (full
 * matrix in `acl/ceiling.unit.test.ts` — surviving owner grant, admin
 * backstop, personal owner-only), the slug + personal-twin
 * preconditions (typed 409s, never a raw index violation), the revive
 * + echo, registry/audit projections.
 */

import {
  COLLECTIONS_DDL,
  createSqliteDriver,
  GRANTS_DDL,
  SPACE_MEMBERS_DDL,
  SPACES_DDL,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  SlugCollisionError,
} from "@editorzero/errors";
import { GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceRestore } from "./restore";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const GRANT_OWNER = UserId("018f0000-0000-7000-8000-0000000000a5");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_LIVE = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const S_TRASHED_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_MISSING = SpaceId("018f0000-0000-7000-8000-0000000000e9");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  db = driver.scoped(WORKSPACE_A);

  await seedSpace(S_TRASHED, "closed", 99);
  await seedSpace(S_LIVE, "open");
  await seedSpace(S_TRASHED_PERSONAL, "private", 99, PERSONAL_OWNER);
});

afterEach(async () => {
  await driver.close();
});

async function seedSpace(
  id: SpaceId,
  type: "open" | "closed" | "private",
  deleted_at: number | null = null,
  personalOwner: UserId | null = null,
  slug = `space-${id.slice(-2)}`,
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
      slug,
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
      /* space.restore enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function restoreInput(space_id: string = S_TRASHED) {
  return spaceRestore.input.parse({ space_id });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.restore — 404s (restore acts on trash only)", () => {
  it.each([
    ["missing space", S_MISSING],
    ["live space", S_LIVE],
  ])("%s → not_found before authority", async (_label, space_id) => {
    const err = await spaceRestore
      .handler(buildCtx(user(ADMIN, ["admin"])), restoreInput(space_id))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
    }
  });
});

describe("space.restore — authority (dead-row ladder wiring)", () => {
  it("plain member → acl_deny scoped to the space", async () => {
    const err = await spaceRestore
      .handler(buildCtx(user(PLAIN_MEMBER)), restoreInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_TRASHED } });
    }
  });

  it("workspace admin (backstop) restores a trashed team space", async () => {
    const out = await spaceRestore.handler(buildCtx(user(ADMIN, ["admin"])), restoreInput());
    expect(out).toEqual({ space_id: S_TRASHED });
  });

  it("a surviving non-guest owner grant restores (grants ride through archive — H1)", async () => {
    await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f1"),
        workspace_id: WORKSPACE_A,
        resource_kind: "space",
        resource_id: S_TRASHED,
        subject_kind: "user",
        subject_id: GRANT_OWNER,
        role: "owner",
        is_guest: 0,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();
    const out = await spaceRestore.handler(buildCtx(user(GRANT_OWNER)), restoreInput());
    expect(out.space_id).toBe(S_TRASHED);
  });

  it("trashed personal space: owner restores; workspace admin denies (privacy pin holds on dead rows)", async () => {
    await expect(
      spaceRestore.handler(buildCtx(user(ADMIN, ["admin"])), restoreInput(S_TRASHED_PERSONAL)),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const out = await spaceRestore.handler(
      buildCtx(user(PERSONAL_OWNER)),
      restoreInput(S_TRASHED_PERSONAL),
    );
    expect(out.space_id).toBe(S_TRASHED_PERSONAL);
  });
});

describe("space.restore — preconditions (typed 409s)", () => {
  it("a LIVE space claimed the slug meanwhile → SlugCollisionError, nothing mutated", async () => {
    // Same slug as S_TRASHED ("space-e1"), live — constructible because
    // the unique index is partial (live rows only).
    await seedSpace(
      SpaceId("018f0000-0000-7000-8000-0000000000e5"),
      "open",
      null,
      null,
      `space-${S_TRASHED.slice(-2)}`,
    );
    const err = await spaceRestore
      .handler(buildCtx(user(ADMIN, ["admin"])), restoreInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlugCollisionError);
    if (err instanceof SlugCollisionError) {
      expect(err.slug).toBe(`space-${S_TRASHED.slice(-2)}`);
    }

    const row = await db
      .selectFrom("spaces")
      .select(["deleted_at"])
      .where("id", "=", S_TRASHED)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBe(99);
  });

  it("a second LIVE personal space for the same owner → ConflictError (spaces_personal_unique pre-check)", async () => {
    // The future member-invitation seeding obligation makes this state
    // constructible; today it needs a direct insert.
    await seedSpace(
      SpaceId("018f0000-0000-7000-8000-0000000000e6"),
      "private",
      null,
      PERSONAL_OWNER,
    );
    await expect(
      spaceRestore.handler(buildCtx(user(PERSONAL_OWNER)), restoreInput(S_TRASHED_PERSONAL)),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("space.restore — application", () => {
  it("clears deleted_at, bumps updated_at, echoes the id; grants/state ride 1:1", async () => {
    const out = await spaceRestore.handler(buildCtx(user(ADMIN, ["admin"]), 9000), restoreInput());
    expect(out).toEqual({ space_id: S_TRASHED });

    const row = await db
      .selectFrom("spaces")
      .select(["deleted_at", "updated_at", "name", "slug", "baseline_access"])
      .where("id", "=", S_TRASHED)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
    expect(row.updated_at).toBe(9000);
    // State-as-of-delete: nothing else changed.
    expect(row.name).toBe(`space-${S_TRASHED.slice(-2)}`);
    expect(row.slug).toBe(`space-${S_TRASHED.slice(-2)}`);
    expect(row.baseline_access).toBe("view");
  });
});

describe("space.restore — input rails", () => {
  it.each([
    ["malformed space_id", { space_id: "not-a-uuid" }],
    ["unknown key", { space_id: S_TRASHED, slug: "new-slug" }],
  ])("%s → schema rejects", (_label, raw) => {
    expect(() => spaceRestore.input.parse(raw)).toThrow();
  });
});

describe("space.restore — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceRestore.id).toBe("space.restore");
    expect(spaceRestore.category).toBe("mutation");
    expect(spaceRestore.requires).toEqual(["space:manage"]);
    expect(spaceRestore.agentAllowed).toEqual({});
    expect(spaceRestore.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(spaceRestore.audit.collapsePolicy).toEqual({ collapsible: false });
  });

  it("projects the space as the audit subject", () => {
    expect(spaceRestore.audit.subjectFrom(restoreInput())).toEqual({
      kind: "space",
      id: S_TRASHED,
    });
  });

  it("emits space.restore (the Step-7 minimal shape)", async () => {
    const input = restoreInput();
    const out = await spaceRestore.handler(buildCtx(user(ADMIN, ["admin"])), input);
    expect(spaceRestore.audit.effectOnAllow(input, out)).toEqual({
      kind: "space.restore",
      space_id: S_TRASHED,
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceRestore.audit.effectOnDeny(restoreInput(), {
      kind: "missing_scope",
      required: ["space:manage"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.restore",
      required_scopes: ["space:manage"],
      reason_code: "missing_scope",
    });
  });
});
