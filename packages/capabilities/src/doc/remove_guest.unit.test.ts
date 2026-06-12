/**
 * `doc.remove_guest` — capability-level integration test against real
 * in-memory SQLite (ADR 0040 Step 8, guest family).
 *
 * Covers, in handler order:
 *   - doc 404 ONLY when the row is missing entirely (orphan-edge
 *     posture) — and the load-bearing inverse: removal WORKS on a
 *     TRASHED doc (Codex guest-family design review, 2026-06-12 —
 *     `permission.revoke` refuses guest edges, so refusing trash here
 *     would make guest edges on trash IMMORTAL offboarding hazards
 *     that resurrect with `doc.restore`);
 *   - the administer ladder over the STORED placement (creator works,
 *     plain member denied, personal docs locked to their owner);
 *   - edge dispositions (Codex SHOULD-FIX — three distinct signals):
 *     absent → 404 on the grant edge; non-guest → typed
 *     `GrantLifecycleConflictError` routing to permission.revoke;
 *     guest → hard DELETE echoing the full preimage;
 *   - input rails, registry metadata + audit projections
 *     (`acl.revoke`, full preimage payload).
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
  GrantLifecycleConflictError,
  NotFoundError,
  PermissionDeniedError,
} from "@editorzero/errors";
import {
  AgentId,
  CollectionId,
  DocId,
  GrantId,
  SpaceId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability, type Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { docRemoveGuest } from "./remove_guest";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const NON_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a5");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");

const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");
const C_PERSONAL = CollectionId("018f0000-0000-7000-8000-0000000000c3");

const D_LEGACY = DocId("018f0000-0000-7000-8000-0000000000d1");
const D_PERSONAL = DocId("018f0000-0000-7000-8000-0000000000d4");
const D_TRASHED = DocId("018f0000-0000-7000-8000-0000000000d5");
const D_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");
const D_FOREIGN = DocId("018f0000-0000-7000-8000-0000000000da");

const G_GUEST = GrantId("018f0000-0000-7000-8000-0000000000f1");
const G_GUEST_TRASH = GrantId("018f0000-0000-7000-8000-0000000000f2");
const G_NONGUEST = GrantId("018f0000-0000-7000-8000-0000000000f5");

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

  await db
    .insertInto("spaces")
    .values({
      id: S_PERSONAL,
      workspace_id: WORKSPACE_A,
      kind: "personal",
      type: "private",
      owner_user_id: PERSONAL_OWNER,
      name: "personal",
      slug: "personal",
      baseline_access: "view",
      created_by: PERSONAL_OWNER,
      created_at: 1,
      updated_at: 1,
      deleted_at: null,
    })
    .execute();
  await db
    .insertInto("collections")
    .values({
      id: C_PERSONAL,
      workspace_id: WORKSPACE_A,
      parent_id: null,
      space_id: S_PERSONAL,
      title: "personal-col",
      slug: "personal-col",
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

  // Guest edges: one on the live legacy doc, one on the TRASHED doc
  // (the immortality regression), plus a non-guest edge for the
  // wrong-lane disposition.
  await seedGrant(G_GUEST, D_LEGACY, NON_MEMBER, 1);
  await seedGrant(G_GUEST_TRASH, D_TRASHED, NON_MEMBER, 1);
  await seedGrant(G_NONGUEST, D_LEGACY, PLAIN_MEMBER, 0, "edit");

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
  doc_id: DocId,
  subject_id: UserId,
  is_guest: 0 | 1,
  role: "view" | "edit" = "view",
) {
  await db
    .insertInto("grants")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc",
      resource_id: doc_id,
      subject_kind: "user",
      subject_id,
      role,
      is_guest,
      created_by: CREATOR,
      created_at: 100,
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
      throw new Error("transact not exercised by doc.remove_guest (metadata-only)");
    },
    outbox: () => {
      /* doc.remove_guest emits no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function removeGuestInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    doc_id: D_LEGACY,
    subject_kind: "user",
    subject_id: NON_MEMBER,
    ...overrides,
  };
}

/** Parse through the capability's own schema — what the dispatcher does. */
function parsedInput(overrides: Partial<Record<string, unknown>> = {}) {
  return docRemoveGuest.input.parse(removeGuestInput(overrides));
}

async function grantById(id: GrantId) {
  return driver.system().selectFrom("grants").selectAll().where("id", "=", id).executeTakeFirst();
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("doc.remove_guest — doc row posture", () => {
  it.each([
    ["missing doc row (orphan-edge posture)", D_MISSING],
    ["cross-tenant doc", D_FOREIGN],
  ])("%s → NotFoundError", async (_label, doc_id) => {
    await expect(
      docRemoveGuest.handler(buildCtx(user(CREATOR)), parsedInput({ doc_id })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("WORKS on a trashed doc — guest edges in trash are removable (not immortal)", async () => {
    const out = await docRemoveGuest.handler(
      buildCtx(user(CREATOR)),
      parsedInput({ doc_id: D_TRASHED }),
    );
    expect(out.grant_id).toBe(G_GUEST_TRASH);
    expect(out.resource_id).toBe(D_TRASHED);
    expect(out.is_guest).toBe(1);
    expect(await grantById(G_GUEST_TRASH)).toBeUndefined();
  });
});

describe("doc.remove_guest — administer ladder over the stored placement", () => {
  it("plain member (no owner-tier rung) → acl_deny, edge untouched", async () => {
    const err = await docRemoveGuest
      .handler(buildCtx(user(PLAIN_MEMBER)), parsedInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_LEGACY } });
    }
    expect(await grantById(G_GUEST)).toBeDefined();
  });

  it("admin backstop administers a legacy doc", async () => {
    const out = await docRemoveGuest.handler(buildCtx(user(ADMIN, ["admin"])), parsedInput());
    expect(out.grant_id).toBe(G_GUEST);
  });

  it("personal-space doc: locked to its owner — even an admin gets acl_deny", async () => {
    await seedGrant(GrantId("018f0000-0000-7000-8000-0000000000f6"), D_PERSONAL, PLAIN_MEMBER, 1);
    await expect(
      docRemoveGuest.handler(
        buildCtx(user(ADMIN, ["admin"])),
        parsedInput({ doc_id: D_PERSONAL, subject_id: PLAIN_MEMBER }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const out = await docRemoveGuest.handler(
      buildCtx(user(PERSONAL_OWNER)),
      parsedInput({ doc_id: D_PERSONAL, subject_id: PLAIN_MEMBER }),
    );
    expect(out.is_guest).toBe(1);
  });
});

describe("doc.remove_guest — edge dispositions", () => {
  it("absent edge → 404 on the grant edge (distinct from the doc 404)", async () => {
    const err = await docRemoveGuest
      .handler(buildCtx(user(CREATOR)), parsedInput({ subject_id: ADMIN }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    if (err instanceof NotFoundError) {
      expect(err.subject_kind).toBe("grant");
    }
  });

  it("edge exists per subject_id but under the OTHER subject_kind → 404 (the triple is the address)", async () => {
    await expect(
      docRemoveGuest.handler(
        buildCtx(user(CREATOR)),
        parsedInput({ subject_kind: "agent", subject_id: BOT }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("non-guest edge → GrantLifecycleConflictError routing to permission.revoke, edge untouched", async () => {
    const err = await docRemoveGuest
      .handler(buildCtx(user(CREATOR)), parsedInput({ subject_id: PLAIN_MEMBER }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrantLifecycleConflictError);
    if (err instanceof GrantLifecycleConflictError) {
      expect(err.existing_lane).toBe("non_guest");
      expect(err.grant_id).toBe(G_NONGUEST);
      expect(err.httpStatus).toBe(409);
      expect(err.toHandlerError()).toEqual({ kind: "conflict" });
    }
    expect(await grantById(G_NONGUEST)).toBeDefined();
  });

  it("guest edge → hard DELETE echoing the full preimage", async () => {
    const out = await docRemoveGuest.handler(buildCtx(user(CREATOR)), parsedInput());
    expect(out).toEqual({
      grant_id: G_GUEST,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_kind: "user",
      subject_id: NON_MEMBER,
      role: "view",
      is_guest: 1,
      created_by: CREATOR,
      created_at: 100,
    });
    expect(await grantById(G_GUEST)).toBeUndefined();
  });

  it("remove → re-add round-trip mints a FRESH grant_id (hard delete, not soft)", async () => {
    const removed = await docRemoveGuest.handler(buildCtx(user(CREATOR)), parsedInput());
    await seedGrant(GrantId("018f0000-0000-7000-8000-0000000000f7"), D_LEGACY, NON_MEMBER, 1);
    const again = await docRemoveGuest.handler(buildCtx(user(CREATOR)), parsedInput());
    expect(again.grant_id).not.toBe(removed.grant_id);
  });
});

// ── Input validation rails ────────────────────────────────────────────────

describe("doc.remove_guest — input rails", () => {
  it.each([
    ["non-UUIDv7 doc_id", removeGuestInput({ doc_id: "not-a-uuid" })],
    ["unknown subject_kind", removeGuestInput({ subject_kind: "team" })],
    ["empty subject_id", removeGuestInput({ subject_id: "" })],
    ["whitespace-only subject_id", removeGuestInput({ subject_id: "   " })],
    ["unknown top-level key (role does not belong here)", removeGuestInput({ role: "view" })],
    [
      "missing subject_id",
      (() => {
        const { subject_id: _sid, ...rest } = removeGuestInput();
        return rest;
      })(),
    ],
  ])("rejects %s", (_label, input) => {
    expect(docRemoveGuest.input.safeParse(input).success).toBe(false);
  });
});

// ── Metadata-only enrolment + registry metadata ──────────────────────────

describe("doc.remove_guest — registry + audit wiring", () => {
  it("is registered in METADATA_ONLY_CAPABILITIES", () => {
    expect(isMetadataOnlyCapability("doc.remove_guest")).toBe(true);
  });

  it("declares the correct registry metadata", () => {
    expect(docRemoveGuest.id).toBe("doc.remove_guest");
    expect(docRemoveGuest.category).toBe("mutation");
    expect(docRemoveGuest.requires).toEqual(["permission:revoke"]);
    expect(docRemoveGuest.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(docRemoveGuest.agentAllowed).toEqual({});
  });

  it("projects the DOC as the audit subject", () => {
    expect(docRemoveGuest.audit.subjectFrom(parsedInput())).toEqual({
      kind: "doc",
      id: D_LEGACY,
    });
  });

  it("emits acl.revoke carrying the full preimage (no created_at)", () => {
    const output = {
      grant_id: G_GUEST,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc" as const,
      resource_id: D_LEGACY,
      subject_kind: "user" as const,
      subject_id: NON_MEMBER,
      role: "view" as const,
      is_guest: 1 as const,
      created_by: CREATOR,
      created_at: 100,
    };
    const effect = docRemoveGuest.audit.effectOnAllow(parsedInput(), output);
    expect(effect).toEqual({
      kind: "acl.revoke",
      grant_id: G_GUEST,
      workspace_id: WORKSPACE_A,
      resource_kind: "doc",
      resource_id: D_LEGACY,
      subject_kind: "user",
      subject_id: NON_MEMBER,
      role: "view",
      is_guest: 1,
      created_by: CREATOR,
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const effect = docRemoveGuest.audit.effectOnDeny(parsedInput(), {
      kind: "missing_scope",
      required: ["permission:revoke"],
      principal_scopes: [],
    });
    expect(effect).toEqual({
      kind: "deny",
      capability: "doc.remove_guest",
      required_scopes: ["permission:revoke"],
      reason_code: "missing_scope",
    });
  });

  it("projects HandlerError kinds via projectErrorAudit", () => {
    const effect = docRemoveGuest.audit.effectOnError(parsedInput(), { kind: "conflict" });
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.remove_guest");
      expect(effect.error_code).toBe("conflict");
    }
  });

  it("declares a non-collapsing audit policy", () => {
    expect(docRemoveGuest.audit.collapsePolicy).toEqual({ collapsible: false });
  });
});
