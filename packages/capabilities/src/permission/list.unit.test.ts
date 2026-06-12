/**
 * `permission.list` — capability-level integration test against real
 * in-memory SQLite (ADR 0040 Step 8).
 *
 * Covers:
 *   - resource 404s (missing / soft-deleted doc and space —
 *     trash-invisible read posture);
 *   - the visibility rule: doc → canRead (creator, doc-grantee incl.
 *     guests, open-baseline member read the panel; outsiders on a
 *     closed space deny acl_deny); space → baseline reach OR
 *     granting authority (space member, admin backstop pass;
 *     reach-less plain member denies; personal space stays owner-only
 *     against admins);
 *   - guest edges ARE listed (the marker is the point);
 *   - pagination: newest-first ordering, peek-limit, composite cursor
 *     resume, next_cursor null on the last page, both-or-neither rail;
 *   - Layer-2 tenant scoping (workspace-B edges never appear);
 *   - input rails, registry metadata, audit projections.
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
import { NotFoundError, PermissionDeniedError } from "@editorzero/errors";
import { CollectionId, DocId, GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import type { GrantRole, Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { permissionList } from "./list";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const SPACE_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a4");
const DOC_GUEST = UserId("018f0000-0000-7000-8000-0000000000a5");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_MISSING = SpaceId("018f0000-0000-7000-8000-0000000000e9");

const C_CLOSED = CollectionId("018f0000-0000-7000-8000-0000000000c1");

const D_LEGACY = DocId("018f0000-0000-7000-8000-0000000000d1");
const D_CLOSED = DocId("018f0000-0000-7000-8000-0000000000d2");
const D_TRASHED = DocId("018f0000-0000-7000-8000-0000000000d5");
const D_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");

let driver: SqliteDriver;
let db: TenantScopedDb;
let grantSeq = 0;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(WORKSPACE_MEMBERS_DDL);
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  driver.exec(DOCS_DDL);
  db = driver.scoped(WORKSPACE_A);
  grantSeq = 0;

  for (const [user_id, role] of [
    [CREATOR, "member"],
    [ADMIN, "admin"],
    [PLAIN_MEMBER, "member"],
    [SPACE_MEMBER, "member"],
    [DOC_GUEST, "guest"],
    [PERSONAL_OWNER, "member"],
  ] as const) {
    await db
      .insertInto("workspace_members")
      .values({
        workspace_id: WORKSPACE_A,
        user_id,
        role,
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
  }

  await seedSpace(S_CLOSED, "closed");
  await seedSpace(S_TRASHED, "open", 99);
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);

  await db
    .insertInto("collections")
    .values({
      id: C_CLOSED,
      workspace_id: WORKSPACE_A,
      parent_id: null,
      space_id: S_CLOSED,
      title: "closed",
      slug: "closed",
      order_key: "a1",
      created_by: CREATOR,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .execute();

  await db
    .insertInto("space_members")
    .values({
      workspace_id: WORKSPACE_A,
      space_id: S_CLOSED,
      user_id: SPACE_MEMBER,
      role: "view",
      created_at: 1,
      updated_at: 1,
    })
    .execute();

  await seedDoc(D_LEGACY, null);
  await seedDoc(D_CLOSED, C_CLOSED);
  await seedDoc(D_TRASHED, null, { deleted_at: 42 });
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

async function seedDoc(
  id: DocId,
  collection_id: CollectionId | null,
  opts: { deleted_at?: number | null } = {},
) {
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
      deleted_at: opts.deleted_at ?? null,
    })
    .execute();
}

/** Seq-minted grant ids: f01, f02, … — lexicographic = mint order. */
async function seedGrant(params: {
  resource_kind: "space" | "doc";
  resource_id: string;
  subject_id: UserId;
  is_guest?: 0 | 1;
  role?: GrantRole;
  created_at?: number;
  workspace_id?: WorkspaceId;
}) {
  grantSeq += 1;
  const id = GrantId(`018f0000-0000-7000-8000-000000000f${grantSeq.toString(16).padStart(2, "0")}`);
  await driver
    .system()
    .insertInto("grants")
    .values({
      id,
      workspace_id: params.workspace_id ?? WORKSPACE_A,
      resource_kind: params.resource_kind,
      resource_id: params.resource_id,
      subject_kind: "user",
      subject_id: params.subject_id,
      role: params.role ?? "view",
      is_guest: params.is_guest ?? 0,
      created_by: CREATOR,
      created_at: params.created_at ?? grantSeq,
    })
    .execute();
  return id;
}

function user(id: UserId, roles: readonly Role[] = ["member"]): UserPrincipal {
  return { kind: "user", id, workspace_id: WORKSPACE_A, roles, session_id: null, token_id: null };
}

function buildCtx(principal: Principal): CapabilityContext {
  return {
    principal,
    tenant: { workspace_id: WORKSPACE_A },
    db,
    transact: async () => {
      throw new Error("reads must not call ctx.transact");
    },
    outbox: () => {
      /* reads never enqueue */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 5000,
  };
}

function listInput(overrides: Partial<Record<string, unknown>> = {}) {
  return permissionList.input.parse({
    resource_kind: "doc",
    resource_id: D_LEGACY,
    ...overrides,
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("permission.list — visibility", () => {
  it("creator lists the doc panel; guest edges included, newest first", async () => {
    const g1 = await seedGrant({
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_id: PLAIN_MEMBER,
      created_at: 10,
    });
    const g2 = await seedGrant({
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_id: DOC_GUEST,
      is_guest: 1,
      created_at: 20,
    });

    const out = await permissionList.handler(buildCtx(user(CREATOR)), listInput());
    expect(out.grants.map((g) => g.grant_id)).toEqual([g2, g1]);
    expect(out.grants[0]?.is_guest).toBe(1);
    expect(out.grants[1]?.is_guest).toBe(0);
    expect(out.next_cursor).toBeNull();
  });

  it("read-tier is NOT enough: legacy-baseline member denies; workspace admin (backstop) lists", async () => {
    // PLAIN_MEMBER can READ D_LEGACY (org-wide legacy baseline) but
    // holds no administer rung — the panel is the sharing graph, not
    // doc content (Codex slice-1 SHOULD-FIX).
    await seedGrant({ resource_kind: "doc", resource_id: D_LEGACY, subject_id: SPACE_MEMBER });

    const err = await permissionList
      .handler(buildCtx(user(PLAIN_MEMBER)), listInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_LEGACY } });
    }

    const byAdmin = await permissionList.handler(buildCtx(user(ADMIN, ["admin"])), listInput());
    expect(byAdmin.grants).toHaveLength(1);
  });

  it("guest grantee cannot enumerate the closed doc's panel; non-guest OWNER-role grantee can", async () => {
    // The guest READS the doc but must not harvest subject ids /
    // grantor attribution off it — guest edges confer zero authority.
    // A non-guest owner-role grantee is owner-tier (owner-by-grant):
    // whoever can edit the panel can read it.
    await seedGrant({
      resource_kind: "doc",
      resource_id: D_CLOSED,
      subject_id: DOC_GUEST,
      is_guest: 1,
    });
    await seedGrant({
      resource_kind: "doc",
      resource_id: D_CLOSED,
      subject_id: SPACE_MEMBER,
      role: "owner",
    });

    const err = await permissionList
      .handler(buildCtx(user(DOC_GUEST, ["guest"])), listInput({ resource_id: D_CLOSED }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_CLOSED } });
    }

    const byOwnerGrantee = await permissionList.handler(
      buildCtx(user(SPACE_MEMBER)),
      listInput({ resource_id: D_CLOSED }),
    );
    expect(byOwnerGrantee.grants).toHaveLength(2);
  });

  it("space panel: plain space member (reach only) denies; owner-role member and workspace admin list", async () => {
    await seedGrant({ resource_kind: "space", resource_id: S_CLOSED, subject_id: SPACE_MEMBER });

    const input = listInput({ resource_kind: "space", resource_id: S_CLOSED });
    // SPACE_MEMBER holds a 'view' membership — reach, not authority.
    const err = await permissionList
      .handler(buildCtx(user(SPACE_MEMBER)), input)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_CLOSED } });
    }

    // Owner-role space MEMBERSHIP is the space owner-tier rung.
    await db
      .insertInto("space_members")
      .values({
        workspace_id: WORKSPACE_A,
        space_id: S_CLOSED,
        user_id: CREATOR,
        role: "owner",
        created_at: 2,
        updated_at: 2,
      })
      .execute();
    const bySpaceOwner = await permissionList.handler(buildCtx(user(CREATOR)), input);
    expect(bySpaceOwner.grants).toHaveLength(1);

    // Workspace admin backstop on a TEAM space.
    const byAdmin = await permissionList.handler(buildCtx(user(ADMIN, ["admin"])), input);
    expect(byAdmin.grants).toHaveLength(1);

    const reachless = await permissionList
      .handler(buildCtx(user(PLAIN_MEMBER)), input)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(reachless).toBeInstanceOf(PermissionDeniedError);
  });

  it("personal space panel: owner lists; workspace admin denies (scenario-3 privacy pin)", async () => {
    const input = listInput({ resource_kind: "space", resource_id: S_PERSONAL });

    const byOwner = await permissionList.handler(buildCtx(user(PERSONAL_OWNER)), input);
    expect(byOwner.grants).toEqual([]);

    await expect(
      permissionList.handler(buildCtx(user(ADMIN, ["admin"])), input),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("permission.list — 404s (trash-invisible)", () => {
  it.each([
    ["missing doc", { resource_kind: "doc", resource_id: D_MISSING }, "doc"],
    ["soft-deleted doc", { resource_kind: "doc", resource_id: D_TRASHED }, "doc"],
    ["missing space", { resource_kind: "space", resource_id: S_MISSING }, "space"],
    ["soft-deleted space", { resource_kind: "space", resource_id: S_TRASHED }, "space"],
  ] as const)("%s → not_found", async (_label, overrides, subject_kind) => {
    const err = await permissionList
      .handler(buildCtx(user(ADMIN, ["admin"])), listInput({ ...overrides }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe(subject_kind);
    }
  });
});

describe("permission.list — pagination + scoping", () => {
  it("pages newest-first with a composite cursor; resumes without overlap; null on the last page", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Two share created_at=30 — the id tiebreak must order them.
      ids.push(
        await seedGrant({
          resource_kind: "doc",
          resource_id: D_LEGACY,
          subject_id: UserId(`018f0000-0000-7000-8000-0000000000b${i.toString(16)}`),
          created_at: i < 2 ? 30 : 10 * i,
        }),
      );
    }

    const page1 = await permissionList.handler(buildCtx(user(CREATOR)), listInput({ limit: 2 }));
    expect(page1.grants).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await permissionList.handler(
      buildCtx(user(CREATOR)),
      listInput({
        limit: 2,
        before_created_at: page1.next_cursor?.before_created_at,
        before_grant_id: page1.next_cursor?.before_grant_id,
      }),
    );
    expect(page2.grants).toHaveLength(2);

    const page3 = await permissionList.handler(
      buildCtx(user(CREATOR)),
      listInput({
        limit: 2,
        before_created_at: page2.next_cursor?.before_created_at,
        before_grant_id: page2.next_cursor?.before_grant_id,
      }),
    );
    expect(page3.grants).toHaveLength(1);
    expect(page3.next_cursor).toBeNull();

    // Union of pages = all five edges, no duplicates, newest-first.
    const seen = [...page1.grants, ...page2.grants, ...page3.grants].map((g) => g.grant_id);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
    const stamps = [...page1.grants, ...page2.grants, ...page3.grants].map((g) => g.created_at);
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
    expect(new Set(ids).size).toBe(5);
  });

  it("exactly-limit rows → next_cursor null (peek row absent)", async () => {
    await seedGrant({ resource_kind: "doc", resource_id: D_LEGACY, subject_id: PLAIN_MEMBER });
    const out = await permissionList.handler(buildCtx(user(CREATOR)), listInput({ limit: 1 }));
    expect(out.grants).toHaveLength(1);
    expect(out.next_cursor).toBeNull();
  });

  it("workspace-B edges on the same doc id never appear (Layer-2 scoping)", async () => {
    await seedGrant({ resource_kind: "doc", resource_id: D_LEGACY, subject_id: PLAIN_MEMBER });
    await seedGrant({
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_id: PLAIN_MEMBER,
      workspace_id: WORKSPACE_B,
    });
    const out = await permissionList.handler(buildCtx(user(CREATOR)), listInput());
    expect(out.grants).toHaveLength(1);
    expect(out.grants[0]?.workspace_id).toBe(WORKSPACE_A);
  });
});

// ── Input validation rails ────────────────────────────────────────────────

describe("permission.list — input rails", () => {
  it.each([
    ["unknown resource_kind", { resource_kind: "collection", resource_id: D_LEGACY }],
    ["non-UUIDv7 resource_id", { resource_kind: "doc", resource_id: "nope" }],
    [
      "cursor timestamp without tiebreak",
      { resource_kind: "doc", resource_id: D_LEGACY, before_created_at: 5 },
    ],
    [
      "cursor tiebreak without timestamp",
      { resource_kind: "doc", resource_id: D_LEGACY, before_grant_id: D_LEGACY },
    ],
    [
      "non-UUIDv7 before_grant_id",
      {
        resource_kind: "doc",
        resource_id: D_LEGACY,
        before_created_at: 5,
        before_grant_id: "junk",
      },
    ],
    ["limit over max", { resource_kind: "doc", resource_id: D_LEGACY, limit: 201 }],
    ["unknown top-level key", { resource_kind: "doc", resource_id: D_LEGACY, subject_id: "x" }],
  ])("rejects %s", (_label, input) => {
    expect(permissionList.input.safeParse(input).success).toBe(false);
  });

  it("defaults limit to 50 and coerces query-string numbers", () => {
    const parsed = permissionList.input.parse({ resource_kind: "doc", resource_id: D_LEGACY });
    expect(parsed.limit).toBe(50);
    const coerced = permissionList.input.parse({
      resource_kind: "doc",
      resource_id: D_LEGACY,
      limit: "25",
    });
    expect(coerced.limit).toBe(25);
  });
});

// ── Registry + audit wiring ───────────────────────────────────────────────

describe("permission.list — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(permissionList.id).toBe("permission.list");
    expect(permissionList.category).toBe("read");
    expect(permissionList.requires).toEqual(["workspace:read"]);
    expect(permissionList.surfaces).toEqual(["api", "cli", "mcp"]);
  });

  it("projects the RESOURCE as the audit subject", () => {
    expect(permissionList.audit.subjectFrom(listInput())).toEqual({
      kind: "doc",
      id: D_LEGACY,
    });
  });

  it("emits the collapsible read access-log effect", () => {
    expect(
      permissionList.audit.effectOnAllow(listInput(), { grants: [], next_cursor: null }),
    ).toEqual({
      kind: "audit.access_log",
    });
    expect(permissionList.audit.collapsePolicy.collapsible).toBe(true);
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const effect = permissionList.audit.effectOnDeny(listInput(), {
      kind: "missing_scope",
      required: ["workspace:read"],
      principal_scopes: [],
    });
    expect(effect).toEqual({
      kind: "deny",
      capability: "permission.list",
      required_scopes: ["workspace:read"],
      reason_code: "missing_scope",
    });
  });

  it("projects HandlerError kinds via projectErrorAudit", () => {
    const effect = permissionList.audit.effectOnError(listInput(), {
      kind: "not_found",
      subject_kind: "doc",
      subject_id: D_MISSING,
    });
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("permission.list");
      expect(effect.error_code).toBe("not_found");
    }
  });
});
