/**
 * `space.update` unit suite — real in-memory SQLite.
 *
 * Pins, in handler order: 404-first trash posture, the
 * `assertCanAdministerSpace` wiring (one cell per ladder rung — the
 * full matrix lives in `acl/ceiling.unit.test.ts`), the personal
 * type/baseline pins, slug collision (excluding self), patch
 * application + echo, effect projection (patch carries ONLY the sent
 * fields), input rails, registry metadata.
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
  NotFoundError,
  PermissionDeniedError,
  SlugCollisionError,
  ValidationError,
} from "@editorzero/errors";
import { SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceUpdate } from "./update";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const SPACE_OWNER = UserId("018f0000-0000-7000-8000-0000000000a4");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const S_TEAM = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_SECOND = SpaceId("018f0000-0000-7000-8000-0000000000e2");
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
  db = driver.scoped(WORKSPACE_A);

  await seedSpace(S_TEAM, "closed");
  await seedSpace(S_SECOND, "open");
  await seedSpace(S_TRASHED, "open", 99);
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);

  // SPACE_OWNER holds the owner-role membership rung on S_TEAM.
  await db
    .insertInto("space_members")
    .values({
      workspace_id: WORKSPACE_A,
      space_id: S_TEAM,
      user_id: SPACE_OWNER,
      role: "owner",
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
      /* space.update enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function updateInput(overrides: Partial<Record<string, unknown>> = {}) {
  return spaceUpdate.input.parse({
    space_id: S_TEAM,
    name: "Renamed",
    ...overrides,
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.update — 404s (trash-invisible)", () => {
  it.each([
    ["missing space", S_MISSING],
    ["soft-deleted space", S_TRASHED],
  ])("%s → not_found before authority", async (_label, space_id) => {
    const err = await spaceUpdate
      .handler(buildCtx(user(ADMIN, ["admin"])), updateInput({ space_id }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
    }
  });
});

describe("space.update — authority (ladder wiring)", () => {
  it("plain member → acl_deny scoped to the space", async () => {
    const err = await spaceUpdate
      .handler(buildCtx(user(PLAIN_MEMBER)), updateInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_TEAM } });
    }
  });

  it("workspace admin (backstop) patches a team space", async () => {
    const out = await spaceUpdate.handler(buildCtx(user(ADMIN, ["admin"])), updateInput());
    expect(out.name).toBe("Renamed");
  });

  it("owner-role space member patches their space", async () => {
    const out = await spaceUpdate.handler(buildCtx(user(SPACE_OWNER)), updateInput());
    expect(out.name).toBe("Renamed");
  });

  it("personal space: owner patches name; workspace admin denies (privacy pin)", async () => {
    const out = await spaceUpdate.handler(
      buildCtx(user(PERSONAL_OWNER)),
      updateInput({ space_id: S_PERSONAL, name: "My drafts" }),
    );
    expect(out.name).toBe("My drafts");

    await expect(
      spaceUpdate.handler(buildCtx(user(ADMIN, ["admin"])), updateInput({ space_id: S_PERSONAL })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("space.update — personal pins", () => {
  it.each([
    ["space_type", { space_type: "open" }],
    ["baseline_access", { baseline_access: "edit" }],
  ])("personal %s patch → ValidationError (structurally private)", async (_label, patch) => {
    const err = await spaceUpdate
      .handler(
        buildCtx(user(PERSONAL_OWNER)),
        updateInput({ space_id: S_PERSONAL, name: undefined, ...patch }),
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("personal_space_type_pinned");
    }
  });

  it("team space type/baseline transitions are allowed", async () => {
    const out = await spaceUpdate.handler(
      buildCtx(user(ADMIN, ["admin"])),
      updateInput({ name: undefined, space_type: "open", baseline_access: "comment" }),
    );
    expect(out.type).toBe("open");
    expect(out.baseline_access).toBe("comment");
  });
});

describe("space.update — patch application", () => {
  it("applies the patch, bumps updated_at, echoes the full row", async () => {
    const out = await spaceUpdate.handler(
      buildCtx(user(ADMIN, ["admin"]), 9000),
      updateInput({ slug: "renamed-space" }),
    );
    expect(out.space_id).toBe(S_TEAM);
    expect(out.name).toBe("Renamed");
    expect(out.slug).toBe("renamed-space");
    expect(out.updated_at).toBe(9000);
    expect(out.created_at).toBe(1);
    expect(out.deleted_at).toBeNull();

    const row = await db
      .selectFrom("spaces")
      .select(["name", "slug", "updated_at"])
      .where("id", "=", S_TEAM)
      .executeTakeFirst();
    expect(row).toEqual({ name: "Renamed", slug: "renamed-space", updated_at: 9000 });
  });

  it("slug collision with another LIVE space → typed 409; own slug is not a collision", async () => {
    await expect(
      spaceUpdate.handler(
        buildCtx(user(ADMIN, ["admin"])),
        updateInput({ name: undefined, slug: `space-${S_SECOND.slice(-2)}` }),
      ),
    ).rejects.toBeInstanceOf(SlugCollisionError);

    // Re-asserting its own current slug is a no-op collision-wise.
    const out = await spaceUpdate.handler(
      buildCtx(user(ADMIN, ["admin"])),
      updateInput({ name: undefined, slug: `space-${S_TEAM.slice(-2)}` }),
    );
    expect(out.slug).toBe(`space-${S_TEAM.slice(-2)}`);
  });
});

describe("space.update — input rails", () => {
  it.each([
    ["empty patch (refine)", { name: undefined }],
    ["unknown key", { kind: "personal" }],
    ["non-kebab slug", { slug: "Has Spaces" }],
    ["bad space_type", { space_type: "secret" }],
    ["owner baseline", { baseline_access: "owner" }],
  ])("%s → schema rejects", (_label, overrides) => {
    expect(() => updateInput(overrides)).toThrow();
  });
});

describe("space.update — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceUpdate.id).toBe("space.update");
    expect(spaceUpdate.category).toBe("mutation");
    expect(spaceUpdate.requires).toEqual(["space:manage"]);
    expect(spaceUpdate.agentAllowed).toEqual({});
    expect(spaceUpdate.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(spaceUpdate.audit.collapsePolicy).toEqual({ collapsible: false });
  });

  it("projects the space as the audit subject", () => {
    expect(spaceUpdate.audit.subjectFrom(updateInput())).toEqual({
      kind: "space",
      id: S_TEAM,
    });
  });

  it("emits space.update whose patch carries ONLY the sent fields", async () => {
    const input = updateInput({ space_type: "open" });
    const out = await spaceUpdate.handler(buildCtx(user(ADMIN, ["admin"])), input);
    const effect = spaceUpdate.audit.effectOnAllow(input, out);
    expect(effect).toEqual({
      kind: "space.update",
      space_id: S_TEAM,
      patch: { name: "Renamed", space_type: "open" },
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceUpdate.audit.effectOnDeny(updateInput(), {
      kind: "missing_scope",
      required: ["space:manage"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.update",
      required_scopes: ["space:manage"],
      reason_code: "missing_scope",
    });
  });
});
