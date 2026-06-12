/**
 * `permission.grant` — capability-level integration test against real
 * in-memory SQLite (ADR 0040 Step 8).
 *
 * Covers, in handler order:
 *   - resource 404s (missing doc/space, soft-deleted doc/space —
 *     trash-invisible posture);
 *   - the granting-authority ladder via `assertCanAdministerDoc` /
 *     `assertCanAdministerSpace` (creator / admin backstop / personal
 *     owner-only / outsider denies — the FULL matrix lives in
 *     `acl/ceiling.unit.test.ts`; here we pin the wiring + one cell
 *     per rung);
 *   - subject rules: live-membership requirement, space-standing per
 *     placement (closed space → ValidationError routing to
 *     doc.add_guest; open space / legacy / member-of-space pass;
 *     personal space → owner only), agent-subject exemption;
 *   - the four upsert branches: fresh INSERT, idempotent same-role
 *     echo (no write), role convergence under the same grant_id with
 *     immutable attribution, guest-edge 409;
 *   - race shapes: ON CONFLICT DO NOTHING zero-row, UPDATE-after-
 *     concurrent-revoke zero-row (asserted via the same SQL shapes,
 *     as in `workspace.member_add`'s race test);
 *   - Layer-2 tenant scoping (workspace-B resources invisible);
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
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from "@editorzero/errors";
import {
  AgentId,
  CollectionId,
  DocId,
  GrantId,
  SpaceId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability, type Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { permissionGrant } from "./grant";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const SPACE_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a4");
const NON_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a5");
const REMOVED_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a6");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_OPEN = SpaceId("018f0000-0000-7000-8000-0000000000e2");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_MISSING = SpaceId("018f0000-0000-7000-8000-0000000000e9");

const C_CLOSED = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const C_OPEN = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const C_PERSONAL = CollectionId("018f0000-0000-7000-8000-0000000000c3");
// Anomaly placements (Codex slice-1 MUST-FIX regression): a collection
// bound to the soft-deleted space, and one whose space ref dangles.
const C_ANOMALY = CollectionId("018f0000-0000-7000-8000-0000000000c4");
const C_DANGLING = CollectionId("018f0000-0000-7000-8000-0000000000c5");

const D_LEGACY = DocId("018f0000-0000-7000-8000-0000000000d1");
const D_CLOSED = DocId("018f0000-0000-7000-8000-0000000000d2");
const D_OPEN = DocId("018f0000-0000-7000-8000-0000000000d3");
const D_PERSONAL = DocId("018f0000-0000-7000-8000-0000000000d4");
const D_TRASHED = DocId("018f0000-0000-7000-8000-0000000000d5");
const D_ANOMALY = DocId("018f0000-0000-7000-8000-0000000000d6");
const D_DANGLING = DocId("018f0000-0000-7000-8000-0000000000d7");
const D_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");
const D_FOREIGN = DocId("018f0000-0000-7000-8000-0000000000da");

const G_GUEST = GrantId("018f0000-0000-7000-8000-0000000000f1");
const G_GUEST_LEGACY = GrantId("018f0000-0000-7000-8000-0000000000f2");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(WORKSPACE_MEMBERS_DDL);
  driver.exec(COLLECTIONS_DDL);
  driver.exec(SPACES_DDL);
  driver.exec(SPACE_MEMBERS_DDL);
  driver.exec(GRANTS_DDL);
  driver.exec(DOCS_DDL);
  db = driver.scoped(WORKSPACE_A);

  // Workspace-A roster. REMOVED_MEMBER is soft-deleted (offboarded).
  for (const [user_id, role, deleted_at] of [
    [CREATOR, "member", null],
    [ADMIN, "admin", null],
    [PLAIN_MEMBER, "member", null],
    [SPACE_MEMBER, "member", null],
    [PERSONAL_OWNER, "member", null],
    [REMOVED_MEMBER, "member", 500],
  ] as const) {
    await db
      .insertInto("workspace_members")
      .values({
        workspace_id: WORKSPACE_A,
        user_id,
        role,
        created_at: 1,
        updated_at: 1,
        deleted_at,
      })
      .execute();
  }

  await seedSpace(S_CLOSED, "closed");
  await seedSpace(S_OPEN, "open");
  // CLOSED so the restore-flow regression can prove the standing rule
  // still blocks a reach-less subject AFTER the space comes back.
  await seedSpace(S_TRASHED, "closed", 99);
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);

  await seedCollection(C_CLOSED, S_CLOSED);
  await seedCollection(C_OPEN, S_OPEN);
  await seedCollection(C_PERSONAL, S_PERSONAL);
  await seedCollection(C_ANOMALY, S_TRASHED);
  await seedCollection(C_DANGLING, S_MISSING);

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
  await seedDoc(D_OPEN, C_OPEN);
  await seedDoc(D_PERSONAL, C_PERSONAL, { created_by: PERSONAL_OWNER });
  await seedDoc(D_TRASHED, null, { deleted_at: 42 });
  await seedDoc(D_ANOMALY, C_ANOMALY);
  await seedDoc(D_DANGLING, C_DANGLING);

  // A pre-existing GUEST edge on the closed doc (the kind doc.add_guest
  // will mint) — permission.grant must refuse to converge it.
  await db
    .insertInto("grants")
    .values({
      id: G_GUEST,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc",
      resource_id: D_CLOSED,
      subject_kind: "user",
      subject_id: NON_MEMBER,
      role: "view",
      is_guest: 1,
      created_by: CREATOR,
      created_at: 1,
    })
    .execute();

  // Workspace-B world: a doc Layer-2 must keep invisible.
  await driver
    .system()
    .insertInto("docs")
    .values({
      id: D_FOREIGN,
      workspace_id: WORKSPACE_B,
      collection_id: null,
      title: "Foreign",
      slug: "foreign",
      order_key: "a0",
      access_mode: "space",
      published_slug: null,
      published_at: null,
      render_version: 0,
      created_by: CREATOR,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
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

async function seedCollection(id: CollectionId, space_id: SpaceId | null) {
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
      deleted_at: null,
    })
    .execute();
}

async function seedDoc(
  id: DocId,
  collection_id: CollectionId | null,
  opts: { created_by?: UserId; deleted_at?: number | null } = {},
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
      created_by: opts.created_by ?? CREATOR,
      created_at: 1,
      updated_at: 1,
      deleted_at: opts.deleted_at ?? null,
    })
    .execute();
}

function user(id: UserId, roles: readonly Role[] = ["member"]): UserPrincipal {
  return { kind: "user", id, workspace_id: WORKSPACE_A, roles, session_id: null, token_id: null };
}

function bot(acting_as?: UserId, owner_user_id: UserId | null = CREATOR): AgentPrincipal {
  return {
    kind: "agent",
    id: BOT,
    workspace_id: WORKSPACE_A,
    owner_user_id,
    scopes: ["permission:grant"],
    token_id: BOT_TOKEN,
    token_kind: acting_as === undefined ? "api-key" : "agent-auth",
    ...(acting_as !== undefined && { acting_as }),
  };
}

function buildCtx(principal: Principal, frozenNow = 5000): CapabilityContext {
  return {
    principal,
    tenant: { workspace_id: WORKSPACE_A },
    db,
    transact: async () => {
      throw new Error("transact not exercised by permission.grant (metadata-only)");
    },
    outbox: () => {
      /* permission.grant emits no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function grantInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    resource_kind: "doc",
    resource_id: D_LEGACY,
    subject_kind: "user",
    subject_id: PLAIN_MEMBER,
    role: "view",
    ...overrides,
  };
}

/** Parse through the capability's own schema — what the dispatcher does. */
function parsedInput(overrides: Partial<Record<string, unknown>> = {}) {
  return permissionGrant.input.parse(grantInput(overrides));
}

async function grantRows() {
  return driver
    .system()
    .selectFrom("grants")
    .selectAll()
    .where("workspace_id", "=", WORKSPACE_A)
    .execute();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("permission.grant — fresh INSERT", () => {
  it("creator mints a non-guest edge on a legacy doc; output echoes the row", async () => {
    const out = await permissionGrant.handler(buildCtx(user(CREATOR), 7000), parsedInput());

    expect(out.workspace_id).toBe(WORKSPACE_A);
    expect(out.resource_kind).toBe("doc");
    expect(out.resource_id).toBe(D_LEGACY);
    expect(out.subject_kind).toBe("user");
    expect(out.subject_id).toBe(PLAIN_MEMBER);
    expect(out.role).toBe("view");
    expect(out.is_guest).toBe(0);
    expect(out.created_by).toBe(CREATOR);
    expect(out.created_at).toBe(7000);

    const row = await driver
      .system()
      .selectFrom("grants")
      .selectAll()
      .where("id", "=", out.grant_id)
      .executeTakeFirstOrThrow();
    expect(row.resource_id).toBe(D_LEGACY);
    expect(row.is_guest).toBe(0);
    expect(row.created_at).toBe(7000);
  });

  it("delegated agent grants with created_by = acting_as (delegator attribution)", async () => {
    const out = await permissionGrant.handler(buildCtx(bot(CREATOR), 7000), parsedInput());
    expect(out.created_by).toBe(CREATOR);
  });

  it("workspace-owned agent (no acting_as, no owner) is refused as unattributable", async () => {
    await expect(
      permissionGrant.handler(buildCtx(bot(undefined, null)), parsedInput()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await grantRows()).toHaveLength(1); // only the seeded guest edge
  });

  it("agent SUBJECT skips membership/standing — even into a closed space", async () => {
    const out = await permissionGrant.handler(
      buildCtx(user(CREATOR)),
      parsedInput({ resource_id: D_CLOSED, subject_kind: "agent", subject_id: BOT }),
    );
    expect(out.subject_kind).toBe("agent");
    expect(out.subject_id).toBe(BOT);
    expect(out.is_guest).toBe(0);
  });
});

describe("permission.grant — resource 404s (trash-invisible)", () => {
  it.each([
    ["missing doc", { resource_kind: "doc", resource_id: D_MISSING }, "doc"],
    ["soft-deleted doc", { resource_kind: "doc", resource_id: D_TRASHED }, "doc"],
    ["missing space", { resource_kind: "space", resource_id: S_MISSING }, "space"],
    ["soft-deleted space", { resource_kind: "space", resource_id: S_TRASHED }, "space"],
  ] as const)("%s → not_found", async (_label, overrides, subject_kind) => {
    const err = await permissionGrant
      .handler(buildCtx(user(CREATOR, ["owner"])), parsedInput({ ...overrides }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe(subject_kind);
      expect(err.subject_id).toBe(overrides.resource_id);
    }
  });

  it("cross-tenant doc is invisible → not_found (Layer-2 scoping)", async () => {
    await expect(
      permissionGrant.handler(buildCtx(user(CREATOR)), parsedInput({ resource_id: D_FOREIGN })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("permission.grant — granting authority (ladder wiring)", () => {
  it("plain member (not creator) on a legacy doc → acl_deny scoped to the doc", async () => {
    const err = await permissionGrant
      .handler(buildCtx(user(PLAIN_MEMBER)), parsedInput({ subject_id: SPACE_MEMBER }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_LEGACY } });
    }
    expect(await grantRows()).toHaveLength(1); // deny did not mutate
  });

  it("workspace admin can grant on a legacy doc they didn't create (admin backstop)", async () => {
    const out = await permissionGrant.handler(buildCtx(user(ADMIN, ["admin"])), parsedInput());
    expect(out.created_by).toBe(ADMIN);
  });

  it("workspace admin CANNOT grant on a personal-space doc (scenario-3 privacy pin)", async () => {
    const err = await permissionGrant
      .handler(
        buildCtx(user(ADMIN, ["admin"])),
        parsedInput({ resource_id: D_PERSONAL, subject_id: PLAIN_MEMBER }),
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
  });

  it("team-space grant: admin backstop administers the space resource", async () => {
    const out = await permissionGrant.handler(
      buildCtx(user(ADMIN, ["admin"])),
      parsedInput({ resource_kind: "space", resource_id: S_CLOSED, subject_id: PLAIN_MEMBER }),
    );
    expect(out.resource_kind).toBe("space");
    expect(out.resource_id).toBe(S_CLOSED);
  });

  it("personal-space resource: owner grants; admin gets acl_deny scoped to the space", async () => {
    const ok = await permissionGrant.handler(
      buildCtx(user(PERSONAL_OWNER)),
      parsedInput({ resource_kind: "space", resource_id: S_PERSONAL, subject_id: PLAIN_MEMBER }),
    );
    expect(ok.resource_id).toBe(S_PERSONAL);

    const err = await permissionGrant
      .handler(
        buildCtx(user(ADMIN, ["admin"])),
        parsedInput({ resource_kind: "space", resource_id: S_PERSONAL, subject_id: SPACE_MEMBER }),
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_PERSONAL } });
    }
  });

  it("delegated agent collapses to the delegator: bot acting for CREATOR grants on CREATOR's doc", async () => {
    const out = await permissionGrant.handler(
      buildCtx(bot(CREATOR)),
      parsedInput({ subject_id: SPACE_MEMBER }),
    );
    expect(out.subject_id).toBe(SPACE_MEMBER);
  });

  it("non-delegated agent has no authority without its own owner-grant — acl_deny", async () => {
    await expect(permissionGrant.handler(buildCtx(bot()), parsedInput())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});

describe("permission.grant — user-subject rules", () => {
  it("subject not a workspace member → ValidationError routing to doc.add_guest", async () => {
    const err = await permissionGrant
      .handler(buildCtx(user(CREATOR)), parsedInput({ subject_id: NON_MEMBER }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("subject_not_workspace_member");
    }
  });

  it("soft-deleted (offboarded) member subject → same ValidationError", async () => {
    await expect(
      permissionGrant.handler(buildCtx(user(CREATOR)), parsedInput({ subject_id: REMOVED_MEMBER })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("closed-space doc + subject without space standing → ValidationError routing to doc.add_guest", async () => {
    const err = await permissionGrant
      .handler(
        buildCtx(user(CREATOR)),
        parsedInput({ resource_id: D_CLOSED, subject_id: PLAIN_MEMBER }),
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("subject_lacks_space_standing");
    }
  });

  it("closed-space doc + subject who IS a space member → grant lands", async () => {
    const out = await permissionGrant.handler(
      buildCtx(user(CREATOR)),
      parsedInput({ resource_id: D_CLOSED, subject_id: SPACE_MEMBER }),
    );
    expect(out.resource_id).toBe(D_CLOSED);
    expect(out.is_guest).toBe(0);
  });

  it("open-space doc: any live member has standing via the open baseline", async () => {
    const out = await permissionGrant.handler(
      buildCtx(user(CREATOR)),
      parsedInput({ resource_id: D_OPEN, subject_id: PLAIN_MEMBER }),
    );
    expect(out.resource_id).toBe(D_OPEN);
  });

  it("personal-space doc: a peer member has NO standing (privacy from peers) — guest flow", async () => {
    await expect(
      permissionGrant.handler(
        buildCtx(user(PERSONAL_OWNER)),
        parsedInput({ resource_id: D_PERSONAL, subject_id: PLAIN_MEMBER }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("space-resource grant needs membership only — that grant IS the standing", async () => {
    const out = await permissionGrant.handler(
      buildCtx(user(ADMIN, ["admin"])),
      parsedInput({ resource_kind: "space", resource_id: S_CLOSED, subject_id: PLAIN_MEMBER }),
    );
    expect(out.subject_id).toBe(PLAIN_MEMBER);
  });
});

describe("permission.grant — anomaly placement refuses (repair-first)", () => {
  // Codex slice-1 review MUST-FIX: a non-guest edge minted while the
  // doc's Space binding is anomalous would, on space.restore, become an
  // unmarked ceiling crossing. The refusal is total — uniform across
  // subject kinds, ahead of the edge lookup — so no write path exists.

  async function anomalyRows() {
    return (await grantRows()).filter((r) => r.resource_id === D_ANOMALY);
  }

  it("trashed-space placement: owner-tier grant mints NO row; after restore, standing still blocks", async () => {
    const duringAnomaly = await permissionGrant
      .handler(buildCtx(user(CREATOR)), parsedInput({ resource_id: D_ANOMALY }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(duringAnomaly).toBeInstanceOf(ValidationError);
    if (duringAnomaly instanceof ValidationError) {
      expect(JSON.stringify(duringAnomaly.issues)).toContain("anomalous_placement_requires_repair");
    }
    expect(await anomalyRows()).toEqual([]);

    // space.restore analogue (the capability lands in slice 2): the
    // binding revives CLOSED, so the reach-less subject is routed to
    // the guest flow — at no point does an unmarked cross-ceiling edge
    // exist (the exact regression Codex asked for).
    await db.updateTable("spaces").set({ deleted_at: null }).where("id", "=", S_TRASHED).execute();

    const afterRestore = await permissionGrant
      .handler(buildCtx(user(CREATOR)), parsedInput({ resource_id: D_ANOMALY }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(afterRestore).toBeInstanceOf(ValidationError);
    if (afterRestore instanceof ValidationError) {
      expect(JSON.stringify(afterRestore.issues)).toContain("subject_lacks_space_standing");
    }
    expect(await anomalyRows()).toEqual([]);
  });

  it("post-restore positive control: an agent subject lands — the refusal was the anomaly, not the doc", async () => {
    await db.updateTable("spaces").set({ deleted_at: null }).where("id", "=", S_TRASHED).execute();
    const out = await permissionGrant.handler(
      buildCtx(user(CREATOR)),
      parsedInput({ resource_id: D_ANOMALY, subject_kind: "agent", subject_id: BOT }),
    );
    expect(out.resource_id).toBe(D_ANOMALY);
    expect(out.is_guest).toBe(0);
  });

  it("agent subjects are refused during the anomaly too (uniform rule, no carve-out)", async () => {
    const err = await permissionGrant
      .handler(
        buildCtx(user(CREATOR)),
        parsedInput({ resource_id: D_ANOMALY, subject_kind: "agent", subject_id: BOT }),
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("anomalous_placement_requires_repair");
    }
  });

  it("dangling space ref is the same anomaly", async () => {
    await expect(
      permissionGrant.handler(buildCtx(user(CREATOR)), parsedInput({ resource_id: D_DANGLING })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await grantRows()).filter((r) => r.resource_id === D_DANGLING)).toEqual([]);
  });

  it("authority still gates first: a plain member gets acl_deny, not the repair rail", async () => {
    const err = await permissionGrant
      .handler(
        buildCtx(user(PLAIN_MEMBER)),
        parsedInput({ resource_id: D_ANOMALY, subject_id: SPACE_MEMBER }),
      )
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_ANOMALY } });
    }
  });
});

describe("permission.grant — upsert branches", () => {
  it("idempotent same-role re-grant: echoes the row, writes nothing", async () => {
    const first = await permissionGrant.handler(buildCtx(user(CREATOR), 7000), parsedInput());
    const again = await permissionGrant.handler(buildCtx(user(CREATOR), 9000), parsedInput());

    expect(again).toEqual(first); // same grant_id, ORIGINAL created_at (7000)
    const rows = await grantRows();
    expect(rows.filter((r) => r.resource_id === D_LEGACY)).toHaveLength(1);
  });

  it("role convergence: same grant_id, role updated, attribution immutable", async () => {
    const first = await permissionGrant.handler(buildCtx(user(CREATOR), 7000), parsedInput());
    // A different authorized principal converges the role — created_by
    // must stay the ORIGINAL grantor (attribution never transfers).
    const converged = await permissionGrant.handler(
      buildCtx(user(ADMIN, ["admin"]), 9000),
      parsedInput({ role: "edit" }),
    );

    expect(converged.grant_id).toBe(first.grant_id);
    expect(converged.role).toBe("edit");
    expect(converged.created_by).toBe(CREATOR);
    expect(converged.created_at).toBe(7000);

    const row = await driver
      .system()
      .selectFrom("grants")
      .selectAll()
      .where("id", "=", first.grant_id)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("edit");
    expect(row.created_by).toBe(CREATOR);
  });

  it("existing GUEST edge → 409 ConflictError (guest lifecycle owns it)", async () => {
    // CREATOR re-grants the exact edge doc.add_guest minted for
    // NON_MEMBER on D_CLOSED. NON_MEMBER isn't a workspace member, so
    // the subject rule would also fire — but the guest-conflict check
    // runs at the EDGE, after standing. Use an in-workspace guest edge
    // instead to isolate the branch.
    await db
      .insertInto("grants")
      .values({
        id: G_GUEST_LEGACY,
        workspace_id: WORKSPACE_A,
        resource_kind: "doc",
        resource_id: D_LEGACY,
        subject_kind: "user",
        subject_id: PLAIN_MEMBER,
        role: "view",
        is_guest: 1,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();

    await expect(
      permissionGrant.handler(buildCtx(user(CREATOR)), parsedInput({ role: "edit" })),
    ).rejects.toBeInstanceOf(ConflictError);

    // The guest edge is untouched — no role flip, no is_guest flip.
    const row = await driver
      .system()
      .selectFrom("grants")
      .selectAll()
      .where("id", "=", G_GUEST_LEGACY)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("view");
    expect(row.is_guest).toBe(1);
  });

  it("race shape: INSERT ON CONFLICT (unique edge) DO NOTHING yields zero rows on a taken edge", async () => {
    await permissionGrant.handler(buildCtx(user(CREATOR)), parsedInput());

    const result = await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f3"),
        workspace_id: WORKSPACE_A,
        resource_kind: "doc",
        resource_id: D_LEGACY,
        subject_kind: "user",
        subject_id: PLAIN_MEMBER,
        role: "owner",
        is_guest: 0,
        created_by: ADMIN,
        created_at: 9999,
      })
      .onConflict((oc) =>
        oc
          .columns(["workspace_id", "resource_kind", "resource_id", "subject_kind", "subject_id"])
          .doNothing(),
      )
      .returning(["id"])
      .executeTakeFirst();
    expect(result).toBeUndefined();
  });

  it("race shape: UPDATE by id after a concurrent revoke yields zero rows", async () => {
    const out = await permissionGrant.handler(buildCtx(user(CREATOR)), parsedInput());
    await db.deleteFrom("grants").where("id", "=", out.grant_id).execute();

    const updated = await db
      .updateTable("grants")
      .set({ role: "edit" })
      .where("id", "=", out.grant_id)
      .returning(["id"])
      .executeTakeFirst();
    expect(updated).toBeUndefined();
  });
});

// ── Input validation rails ────────────────────────────────────────────────

describe("permission.grant — input rails", () => {
  it.each([
    ["unknown resource_kind", grantInput({ resource_kind: "collection" })],
    ["non-UUIDv7 resource_id", grantInput({ resource_id: "not-a-uuid" })],
    ["unknown subject_kind", grantInput({ subject_kind: "team" })],
    ["empty subject_id", grantInput({ subject_id: "" })],
    ["unknown role", grantInput({ role: "superuser" })],
    [
      "missing role",
      (() => {
        const { role: _role, ...rest } = grantInput();
        return rest;
      })(),
    ],
    ["unknown top-level key", grantInput({ workspace_id: "hijack" })],
  ])("rejects %s", (_label, input) => {
    expect(permissionGrant.input.safeParse(input).success).toBe(false);
  });
});

// ── Metadata-only enrolment + registry metadata ──────────────────────────

describe("permission.grant — registry + audit wiring", () => {
  it("is registered in METADATA_ONLY_CAPABILITIES", () => {
    expect(isMetadataOnlyCapability("permission.grant")).toBe(true);
  });

  it("declares the correct registry metadata", () => {
    expect(permissionGrant.id).toBe("permission.grant");
    expect(permissionGrant.category).toBe("mutation");
    expect(permissionGrant.requires).toEqual(["permission:grant"]);
    expect(permissionGrant.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(permissionGrant.agentAllowed).toEqual({});
  });

  it("projects the RESOURCE as the audit subject", () => {
    expect(permissionGrant.audit.subjectFrom(parsedInput())).toEqual({
      kind: "doc",
      id: D_LEGACY,
    });
    expect(
      permissionGrant.audit.subjectFrom(
        parsedInput({ resource_kind: "space", resource_id: S_CLOSED }),
      ),
    ).toEqual({ kind: "space", id: S_CLOSED });
  });

  it("emits acl.grant mirroring GrantState exactly (no created_at)", () => {
    const output = {
      grant_id: GrantId("018f0000-0000-7000-8000-0000000000f4"),
      workspace_id: WORKSPACE_A,
      resource_kind: "doc" as const,
      resource_id: D_LEGACY,
      subject_kind: "user" as const,
      subject_id: PLAIN_MEMBER,
      role: "view" as const,
      is_guest: 0 as const,
      created_by: CREATOR,
      created_at: 7000,
    };
    const effect = permissionGrant.audit.effectOnAllow(parsedInput(), output);
    expect(effect).toEqual({
      kind: "acl.grant",
      grant_id: output.grant_id,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_kind: "user",
      subject_id: PLAIN_MEMBER,
      role: "view",
      is_guest: 0,
      created_by: CREATOR,
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const effect = permissionGrant.audit.effectOnDeny(parsedInput(), {
      kind: "missing_scope",
      required: ["permission:grant"],
      principal_scopes: [],
    });
    expect(effect).toEqual({
      kind: "deny",
      capability: "permission.grant",
      required_scopes: ["permission:grant"],
      reason_code: "missing_scope",
    });
  });

  it("projects HandlerError kinds via projectErrorAudit", () => {
    const effect = permissionGrant.audit.effectOnError(parsedInput(), { kind: "conflict" });
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("permission.grant");
      expect(effect.error_code).toBe("conflict");
    }
  });

  it("declares a non-collapsing audit policy", () => {
    expect(permissionGrant.audit.collapsePolicy).toEqual({ collapsible: false });
  });
});
