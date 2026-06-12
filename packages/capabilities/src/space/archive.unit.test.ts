/**
 * `space.archive` unit suite — real in-memory SQLite.
 *
 * Pins, in handler order: 404-first trash posture, the
 * `assertCanAdministerSpace` wiring (full matrix in
 * `acl/ceiling.unit.test.ts`), the three-count live-descendants
 * refusal (live collections / live docs through live collections /
 * members — trashed subtrees don't block), the soft-delete + echo,
 * registry/audit projections.
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
import {
  NotFoundError,
  PermissionDeniedError,
  SpaceHasLiveDescendantsError,
} from "@editorzero/errors";
import { CollectionId, DocId, GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceArchive } from "./archive";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const GRANT_OWNER = UserId("018f0000-0000-7000-8000-0000000000a5");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const S_TEAM = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_BUSY = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_MISSING = SpaceId("018f0000-0000-7000-8000-0000000000e9");

const C_LIVE = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const C_TRASHED = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const D_LIVE = DocId("018f0000-0000-7000-8000-0000000000d1");
const D_LIVE_2 = DocId("018f0000-0000-7000-8000-0000000000d2");
const D_TRASHED = DocId("018f0000-0000-7000-8000-0000000000d3");

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
  await seedSpace(S_BUSY, "open");
  await seedSpace(S_TRASHED, "open", 99);
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);
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

async function seedCollection(
  id: CollectionId,
  space_id: SpaceId,
  deleted_at: number | null = null,
) {
  await db
    .insertInto("collections")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      parent_id: null,
      space_id,
      title: `col-${id.slice(-2)}`,
      slug: `col-${id.slice(-2)}`,
      order_key: `a${id.slice(-2)}`,
      created_by: CREATOR,
      created_at: 1,
      updated_at: 1,
      deleted_at,
    })
    .execute();
}

async function seedDoc(id: DocId, collection_id: CollectionId, deleted_at: number | null = null) {
  await db
    .insertInto("docs")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      collection_id,
      title: `doc-${id.slice(-2)}`,
      slug: `doc-${id.slice(-2)}`,
      order_key: `a${id.slice(-2)}`,
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
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
      /* space.archive enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function archiveInput(space_id: string = S_TEAM) {
  return spaceArchive.input.parse({ space_id });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.archive — 404s (trash-invisible)", () => {
  it.each([
    ["missing space", S_MISSING],
    ["already-trashed space", S_TRASHED],
  ])("%s → not_found before authority", async (_label, space_id) => {
    const err = await spaceArchive
      .handler(buildCtx(user(ADMIN, ["admin"])), archiveInput(space_id))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
    }
  });
});

describe("space.archive — authority (ladder wiring)", () => {
  it("plain member → acl_deny scoped to the space", async () => {
    const err = await spaceArchive
      .handler(buildCtx(user(PLAIN_MEMBER)), archiveInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_TEAM } });
    }
  });

  it("workspace admin (backstop) archives an empty team space", async () => {
    const out = await spaceArchive.handler(buildCtx(user(ADMIN, ["admin"]), 9000), archiveInput());
    expect(out).toEqual({ space_id: S_TEAM, deleted_at: 9000 });
  });

  it("non-guest owner-grant holder archives (the grant-yourself-then-leave escape)", async () => {
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
    const out = await spaceArchive.handler(buildCtx(user(GRANT_OWNER)), archiveInput());
    expect(out.space_id).toBe(S_TEAM);
  });

  it("personal space: owner archives their drafts home; workspace admin denies (privacy pin)", async () => {
    const out = await spaceArchive.handler(
      buildCtx(user(PERSONAL_OWNER)),
      archiveInput(S_PERSONAL),
    );
    expect(out.space_id).toBe(S_PERSONAL);

    // Reset for the admin half.
    await db.updateTable("spaces").set({ deleted_at: null }).where("id", "=", S_PERSONAL).execute();
    await expect(
      spaceArchive.handler(buildCtx(user(ADMIN, ["admin"])), archiveInput(S_PERSONAL)),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("space.archive — live-descendants refusal", () => {
  it("refuses with the three counts: live collections + live docs + members", async () => {
    await seedCollection(C_LIVE, S_BUSY);
    await seedDoc(D_LIVE, C_LIVE);
    await seedDoc(D_LIVE_2, C_LIVE);
    await db
      .insertInto("space_members")
      .values({
        workspace_id: WORKSPACE_A,
        space_id: S_BUSY,
        user_id: PLAIN_MEMBER,
        role: "view",
        created_at: 1,
        updated_at: 1,
      })
      .execute();

    const err = await spaceArchive
      .handler(buildCtx(user(ADMIN, ["admin"])), archiveInput(S_BUSY))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpaceHasLiveDescendantsError);
    if (err instanceof SpaceHasLiveDescendantsError) {
      expect(err.descendant_counts).toEqual({ collections: 1, docs: 2, members: 1 });
      expect(err.code).toBe("has_live_descendants");
    }

    // The refusal mutated nothing.
    const row = await db
      .selectFrom("spaces")
      .select(["deleted_at"])
      .where("id", "=", S_BUSY)
      .executeTakeFirstOrThrow();
    expect(row.deleted_at).toBeNull();
  });

  it("trashed subtrees don't block: a trashed collection (with its trashed doc) is already in the trash", async () => {
    await seedCollection(C_TRASHED, S_BUSY, 42);
    await seedDoc(D_TRASHED, C_TRASHED, 42);

    const out = await spaceArchive.handler(
      buildCtx(user(ADMIN, ["admin"]), 9000),
      archiveInput(S_BUSY),
    );
    expect(out).toEqual({ space_id: S_BUSY, deleted_at: 9000 });
  });

  it("a live doc inside a TRASHED collection does not count (corrupt-state honesty: the join is live-collections-only)", async () => {
    // Constructible only out-of-band (doc.restore refuses a trashed
    // parent) — the count mirrors collection.delete's direct-children
    // philosophy: the trashed collection is the trash's problem.
    await seedCollection(C_TRASHED, S_BUSY, 42);
    await seedDoc(D_LIVE, C_TRASHED);

    const out = await spaceArchive.handler(buildCtx(user(ADMIN, ["admin"])), archiveInput(S_BUSY));
    expect(out.space_id).toBe(S_BUSY);
  });
});

describe("space.archive — application", () => {
  it("sets deleted_at + updated_at to the handler clock and echoes both", async () => {
    const out = await spaceArchive.handler(buildCtx(user(ADMIN, ["admin"]), 9000), archiveInput());
    expect(out).toEqual({ space_id: S_TEAM, deleted_at: 9000 });

    const row = await db
      .selectFrom("spaces")
      .select(["deleted_at", "updated_at"])
      .where("id", "=", S_TEAM)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ deleted_at: 9000, updated_at: 9000 });
  });

  it("grants on the space survive the archive (H1 — state-as-of-delete)", async () => {
    await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f2"),
        workspace_id: WORKSPACE_A,
        resource_kind: "space",
        resource_id: S_TEAM,
        subject_kind: "user",
        subject_id: PLAIN_MEMBER,
        role: "view",
        is_guest: 0,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();
    await spaceArchive.handler(buildCtx(user(ADMIN, ["admin"])), archiveInput());

    const grants = await db.selectFrom("grants").select(["id"]).execute();
    expect(grants).toHaveLength(1);
  });
});

describe("space.archive — input rails", () => {
  it.each([
    ["malformed space_id", { space_id: "not-a-uuid" }],
    ["unknown key", { space_id: S_TEAM, force: true }],
  ])("%s → schema rejects", (_label, raw) => {
    expect(() => spaceArchive.input.parse(raw)).toThrow();
  });
});

describe("space.archive — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceArchive.id).toBe("space.archive");
    expect(spaceArchive.category).toBe("mutation");
    expect(spaceArchive.requires).toEqual(["space:manage"]);
    expect(spaceArchive.agentAllowed).toEqual({});
    expect(spaceArchive.surfaces).toEqual(["api", "cli", "mcp", "ui"]);
    expect(spaceArchive.audit.collapsePolicy).toEqual({ collapsible: false });
  });

  it("projects the space as the audit subject", () => {
    expect(spaceArchive.audit.subjectFrom(archiveInput())).toEqual({
      kind: "space",
      id: S_TEAM,
    });
  });

  it("emits space.archive carrying the handler clock", async () => {
    const input = archiveInput();
    const out = await spaceArchive.handler(buildCtx(user(ADMIN, ["admin"]), 9000), input);
    expect(spaceArchive.audit.effectOnAllow(input, out)).toEqual({
      kind: "space.archive",
      space_id: S_TEAM,
      deleted_at: 9000,
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceArchive.audit.effectOnDeny(archiveInput(), {
      kind: "missing_scope",
      required: ["space:manage"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.archive",
      required_scopes: ["space:manage"],
      reason_code: "missing_scope",
    });
  });
});
