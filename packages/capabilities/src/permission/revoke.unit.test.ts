/**
 * `permission.revoke` — capability-level integration test against real
 * in-memory SQLite (ADR 0040 Step 8).
 *
 * Covers, in handler order:
 *   - grant 404s: unknown id, cross-tenant id (Layer-2 makes them
 *     indistinguishable), already-revoked id;
 *   - the guest-edge rail (ValidationError routing to
 *     doc.remove_guest);
 *   - resource-row postures: orphan doc/space grant → 404 on the
 *     resource (inert until repair); TRASHED doc → revoke ALLOWED
 *     (offboarding posture — trimming a trashed doc's ACL must not
 *     require restoring it); TRASHED space → acl_deny (restore-first:
 *     the space ladder never administers trashed spaces);
 *   - authority wiring: creator / admin backstop / personal owner-only
 *     / plain-member deny — one cell per rung (full matrix in
 *     `acl/ceiling.unit.test.ts`);
 *   - the DELETE: row gone, output = FULL preimage (H1 — this echo and
 *     the acl.revoke effect are the only durable record);
 *   - registry metadata + audit projections.
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
import { NotFoundError, PermissionDeniedError, ValidationError } from "@editorzero/errors";
import { CollectionId, DocId, GrantId, SpaceId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { type GrantRole, isMetadataOnlyCapability, type Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { permissionRevoke } from "./revoke";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const GRANTEE = UserId("018f0000-0000-7000-8000-0000000000a4");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const S_MISSING = SpaceId("018f0000-0000-7000-8000-0000000000e9");

const C_PERSONAL = CollectionId("018f0000-0000-7000-8000-0000000000c3");

const D_LEGACY = DocId("018f0000-0000-7000-8000-0000000000d1");
const D_PERSONAL = DocId("018f0000-0000-7000-8000-0000000000d4");
const D_TRASHED = DocId("018f0000-0000-7000-8000-0000000000d5");
const D_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");

// Seeded edges (one per posture under test).
const G_LEGACY = GrantId("018f0000-0000-7000-8000-0000000000f1");
const G_GUEST = GrantId("018f0000-0000-7000-8000-0000000000f2");
const G_ORPHAN_DOC = GrantId("018f0000-0000-7000-8000-0000000000f3");
const G_TRASHED_DOC = GrantId("018f0000-0000-7000-8000-0000000000f4");
const G_SPACE = GrantId("018f0000-0000-7000-8000-0000000000f5");
const G_TRASHED_SPACE = GrantId("018f0000-0000-7000-8000-0000000000f6");
const G_ORPHAN_SPACE = GrantId("018f0000-0000-7000-8000-0000000000f7");
const G_PERSONAL_SPACE = GrantId("018f0000-0000-7000-8000-0000000000f8");
const G_FOREIGN = GrantId("018f0000-0000-7000-8000-0000000000f9");
const G_UNKNOWN = GrantId("018f0000-0000-7000-8000-0000000000ff");

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

  for (const [user_id, role] of [
    [CREATOR, "member"],
    [ADMIN, "admin"],
    [PLAIN_MEMBER, "member"],
    [GRANTEE, "member"],
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
      id: C_PERSONAL,
      workspace_id: WORKSPACE_A,
      parent_id: null,
      space_id: S_PERSONAL,
      title: "personal",
      slug: "personal",
      order_key: "a1",
      created_by: PERSONAL_OWNER,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .execute();

  await seedDoc(D_LEGACY, null);
  await seedDoc(D_PERSONAL, C_PERSONAL, { created_by: PERSONAL_OWNER });
  await seedDoc(D_TRASHED, null, { deleted_at: 42 });

  await seedGrant(G_LEGACY, { resource_kind: "doc", resource_id: D_LEGACY });
  // Distinct subject: the unique edge index allows ONE row per
  // (resource, subject) pair — guest-ness is a property of the edge,
  // not a parallel edge (exactly why permission.grant 409s on it).
  await seedGrant(G_GUEST, {
    resource_kind: "doc",
    resource_id: D_LEGACY,
    is_guest: 1,
    subject_id: PLAIN_MEMBER,
  });
  await seedGrant(G_ORPHAN_DOC, { resource_kind: "doc", resource_id: D_MISSING });
  await seedGrant(G_TRASHED_DOC, { resource_kind: "doc", resource_id: D_TRASHED });
  await seedGrant(G_SPACE, { resource_kind: "space", resource_id: S_CLOSED });
  await seedGrant(G_TRASHED_SPACE, { resource_kind: "space", resource_id: S_TRASHED });
  await seedGrant(G_ORPHAN_SPACE, { resource_kind: "space", resource_id: S_MISSING });
  await seedGrant(G_PERSONAL_SPACE, {
    resource_kind: "space",
    resource_id: S_PERSONAL,
    created_by: PERSONAL_OWNER,
  });

  // Workspace-B edge — Layer-2 must keep it invisible by id.
  await driver
    .system()
    .insertInto("grants")
    .values({
      id: G_FOREIGN,
      workspace_id: WORKSPACE_B,
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_kind: "user",
      subject_id: GRANTEE,
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

async function seedGrant(
  id: GrantId,
  params: {
    resource_kind: "space" | "doc";
    resource_id: string;
    is_guest?: 0 | 1;
    role?: GrantRole;
    created_by?: UserId;
    subject_id?: UserId;
  },
) {
  await db
    .insertInto("grants")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      resource_kind: params.resource_kind,
      resource_id: params.resource_id,
      subject_kind: "user",
      subject_id: params.subject_id ?? GRANTEE,
      role: params.role ?? "view",
      is_guest: params.is_guest ?? 0,
      created_by: params.created_by ?? CREATOR,
      created_at: 1,
    })
    .execute();
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
      throw new Error("transact not exercised by permission.revoke (metadata-only)");
    },
    outbox: () => {
      /* permission.revoke emits no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 5000,
  };
}

async function grantExists(id: GrantId): Promise<boolean> {
  const row = await driver
    .system()
    .selectFrom("grants")
    .select(["id"])
    .where("id", "=", id)
    .executeTakeFirst();
  return row !== undefined;
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("permission.revoke — happy paths", () => {
  it("creator revokes a doc edge; row deleted; output = FULL preimage", async () => {
    const out = await permissionRevoke.handler(buildCtx(user(CREATOR)), {
      grant_id: G_LEGACY,
    });

    expect(out).toEqual({
      grant_id: G_LEGACY,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_kind: "user",
      subject_id: GRANTEE,
      role: "view",
      is_guest: 0,
      created_by: CREATOR,
      created_at: 1,
    });
    expect(await grantExists(G_LEGACY)).toBe(false);
  });

  it("TRASHED doc edge is revocable (offboarding posture — no restore required)", async () => {
    const out = await permissionRevoke.handler(buildCtx(user(CREATOR)), {
      grant_id: G_TRASHED_DOC,
    });
    expect(out.resource_id).toBe(D_TRASHED);
    expect(await grantExists(G_TRASHED_DOC)).toBe(false);
  });

  it("admin backstop revokes a team-space edge", async () => {
    const out = await permissionRevoke.handler(buildCtx(user(ADMIN, ["admin"])), {
      grant_id: G_SPACE,
    });
    expect(out.resource_kind).toBe("space");
    expect(out.resource_id).toBe(S_CLOSED);
    expect(await grantExists(G_SPACE)).toBe(false);
  });

  it("personal-space edge: the personal owner revokes", async () => {
    const out = await permissionRevoke.handler(buildCtx(user(PERSONAL_OWNER)), {
      grant_id: G_PERSONAL_SPACE,
    });
    expect(out.created_by).toBe(PERSONAL_OWNER);
    expect(await grantExists(G_PERSONAL_SPACE)).toBe(false);
  });
});

describe("permission.revoke — 404s", () => {
  it("unknown grant id → not_found with subject_kind 'grant'", async () => {
    const err = await permissionRevoke
      .handler(buildCtx(user(CREATOR)), { grant_id: G_UNKNOWN })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("grant");
      expect(err.subject_id).toBe(G_UNKNOWN);
    }
  });

  it("cross-tenant grant id is invisible → not_found (Layer-2 scoping)", async () => {
    await expect(
      permissionRevoke.handler(buildCtx(user(ADMIN, ["admin"])), { grant_id: G_FOREIGN }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await grantExists(G_FOREIGN)).toBe(true); // workspace-B row untouched
  });

  it("orphan doc edge (resource row gone) → not_found on the DOC; edge stays inert", async () => {
    const err = await permissionRevoke
      .handler(buildCtx(user(ADMIN, ["admin"])), { grant_id: G_ORPHAN_DOC })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("doc");
      expect(err.subject_id).toBe(D_MISSING);
    }
    expect(await grantExists(G_ORPHAN_DOC)).toBe(true);
  });

  it("orphan space edge → not_found on the SPACE; edge stays inert", async () => {
    const err = await permissionRevoke
      .handler(buildCtx(user(ADMIN, ["admin"])), { grant_id: G_ORPHAN_SPACE })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("space");
    }
    expect(await grantExists(G_ORPHAN_SPACE)).toBe(true);
  });
});

describe("permission.revoke — rails + denies", () => {
  it("guest edge → ValidationError routing to doc.remove_guest; edge untouched", async () => {
    const err = await permissionRevoke
      .handler(buildCtx(user(CREATOR)), { grant_id: G_GUEST })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("guest_grant_requires_remove_guest");
    }
    expect(await grantExists(G_GUEST)).toBe(true);
  });

  it("TRASHED space edge → acl_deny scoped to the space (restore-first posture)", async () => {
    const err = await permissionRevoke
      .handler(buildCtx(user(ADMIN, ["admin"])), { grant_id: G_TRASHED_SPACE })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { space_id: S_TRASHED } });
    }
    expect(await grantExists(G_TRASHED_SPACE)).toBe(true);
  });

  it("plain member (no authority on the doc) → acl_deny; edge untouched", async () => {
    const err = await permissionRevoke
      .handler(buildCtx(user(PLAIN_MEMBER)), { grant_id: G_LEGACY })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_LEGACY } });
    }
    expect(await grantExists(G_LEGACY)).toBe(true);
  });

  it("personal-space edge: workspace admin gets acl_deny (scenario-3 privacy pin)", async () => {
    await expect(
      permissionRevoke.handler(buildCtx(user(ADMIN, ["admin"])), {
        grant_id: G_PERSONAL_SPACE,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await grantExists(G_PERSONAL_SPACE)).toBe(true);
  });

  it("race shape: DELETE by id on an already-deleted row yields zero rows", async () => {
    await db.deleteFrom("grants").where("id", "=", G_LEGACY).execute();
    const deleted = await db
      .deleteFrom("grants")
      .where("id", "=", G_LEGACY)
      .returning(["id"])
      .executeTakeFirst();
    expect(deleted).toBeUndefined();
  });
});

// ── Input validation rails ────────────────────────────────────────────────

describe("permission.revoke — input rails", () => {
  it("rejects a non-UUIDv7 grant_id", () => {
    expect(permissionRevoke.input.safeParse({ grant_id: "nope" }).success).toBe(false);
  });

  it("rejects missing grant_id", () => {
    expect(permissionRevoke.input.safeParse({}).success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(permissionRevoke.input.safeParse({ grant_id: G_LEGACY, force: true }).success).toBe(
      false,
    );
  });
});

// ── Metadata-only enrolment + registry + audit ────────────────────────────

describe("permission.revoke — registry + audit wiring", () => {
  it("is registered in METADATA_ONLY_CAPABILITIES", () => {
    expect(isMetadataOnlyCapability("permission.revoke")).toBe(true);
  });

  it("declares the correct registry metadata", () => {
    expect(permissionRevoke.id).toBe("permission.revoke");
    expect(permissionRevoke.category).toBe("mutation");
    expect(permissionRevoke.requires).toEqual(["permission:revoke"]);
    expect(permissionRevoke.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(permissionRevoke.agentAllowed).toEqual({});
  });

  it("projects the GRANT as the audit subject", () => {
    expect(permissionRevoke.audit.subjectFrom({ grant_id: G_LEGACY })).toEqual({
      kind: "grant",
      id: G_LEGACY,
    });
  });

  it("emits acl.revoke carrying the FULL preimage (no created_at — GrantState shape)", () => {
    const output = {
      grant_id: G_LEGACY,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc" as const,
      resource_id: D_LEGACY,
      subject_kind: "user" as const,
      subject_id: GRANTEE,
      role: "view" as const,
      is_guest: 0 as const,
      created_by: CREATOR,
      created_at: 1,
    };
    const effect = permissionRevoke.audit.effectOnAllow({ grant_id: G_LEGACY }, output);
    expect(effect).toEqual({
      kind: "acl.revoke",
      grant_id: G_LEGACY,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_kind: "user",
      subject_id: GRANTEE,
      role: "view",
      is_guest: 0,
      created_by: CREATOR,
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const effect = permissionRevoke.audit.effectOnDeny(
      { grant_id: G_LEGACY },
      { kind: "missing_scope", required: ["permission:revoke"], principal_scopes: [] },
    );
    expect(effect).toEqual({
      kind: "deny",
      capability: "permission.revoke",
      required_scopes: ["permission:revoke"],
      reason_code: "missing_scope",
    });
  });

  it("projects HandlerError kinds via projectErrorAudit", () => {
    const effect = permissionRevoke.audit.effectOnError(
      { grant_id: G_LEGACY },
      {
        kind: "not_found",
        subject_kind: "grant",
        subject_id: G_LEGACY,
      },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("permission.revoke");
      expect(effect.error_code).toBe("not_found");
    }
  });

  it("declares a non-collapsing audit policy", () => {
    expect(permissionRevoke.audit.collapsePolicy).toEqual({ collapsible: false });
  });
});
