/**
 * `doc.add_guest` — capability-level integration test against real
 * in-memory SQLite (ADR 0040 Step 8, guest family).
 *
 * Covers, in handler order:
 *   - doc 404s (missing, soft-deleted, cross-tenant — trash-invisible
 *     posture; sharing trash is doc.restore-first);
 *   - the administer ladder wiring (creator mints / plain member
 *     denied / admin backstop on legacy / personal docs locked to
 *     their owner even against admins — full matrix lives in
 *     `acl/ceiling.unit.test.ts`);
 *   - the verb's POINT — the deliberate asymmetries with
 *     `permission.grant` (Codex guest-family design review,
 *     2026-06-12): non-member subjects accepted, standing-less
 *     member subjects accepted on closed-space docs, agent subjects
 *     accepted, anomalous placement does NOT refuse (owner-tier-bounded
 *     recovery sharing — the slice-1 MUST-FIX text reserved exactly
 *     this verb for it);
 *   - upsert branches: fresh INSERT (`is_guest = 1`), idempotent
 *     same-role echo (zero writes), role convergence under the same
 *     grant_id with immutable attribution, NON-guest edge → typed
 *     `GrantLifecycleConflictError` (the lane mirror of
 *     permission.grant's guest-edge conflict);
 *   - the guest-lane INSERT race SQL shape (ON CONFLICT DO NOTHING
 *     zero-row);
 *   - input rails — notably guest `owner` is unmintable BY SCHEMA;
 *   - attribution (`resolveCreatedBy`): agent caller attributes to
 *     `acting_as` / `owner_user_id`; workspace-owned agent refused;
 *   - registry metadata + audit projections (`acl.grant`, is_guest 1).
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
import { docAddGuest } from "./add_guest";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");

const CREATOR = UserId("018f0000-0000-7000-8000-0000000000a1");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const PLAIN_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const NON_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a5");
const PERSONAL_OWNER = UserId("018f0000-0000-7000-8000-0000000000a7");

const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

const S_CLOSED = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const S_TRASHED = SpaceId("018f0000-0000-7000-8000-0000000000e3");
const S_PERSONAL = SpaceId("018f0000-0000-7000-8000-0000000000e4");

const C_CLOSED = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const C_PERSONAL = CollectionId("018f0000-0000-7000-8000-0000000000c3");
const C_ANOMALY = CollectionId("018f0000-0000-7000-8000-0000000000c4");

const D_LEGACY = DocId("018f0000-0000-7000-8000-0000000000d1");
const D_CLOSED = DocId("018f0000-0000-7000-8000-0000000000d2");
const D_PERSONAL = DocId("018f0000-0000-7000-8000-0000000000d4");
const D_TRASHED = DocId("018f0000-0000-7000-8000-0000000000d5");
const D_ANOMALY = DocId("018f0000-0000-7000-8000-0000000000d6");
const D_MISSING = DocId("018f0000-0000-7000-8000-0000000000d9");
const D_FOREIGN = DocId("018f0000-0000-7000-8000-0000000000da");

const G_NONGUEST = GrantId("018f0000-0000-7000-8000-0000000000f1");

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

  await seedSpace(S_CLOSED, "closed");
  await seedSpace(S_TRASHED, "closed", 99);
  await seedSpace(S_PERSONAL, "private", null, PERSONAL_OWNER);

  await seedCollection(C_CLOSED, S_CLOSED);
  await seedCollection(C_PERSONAL, S_PERSONAL);
  await seedCollection(C_ANOMALY, S_TRASHED);

  await seedDoc(D_LEGACY, null);
  await seedDoc(D_CLOSED, C_CLOSED);
  await seedDoc(D_PERSONAL, C_PERSONAL, { created_by: PERSONAL_OWNER });
  await seedDoc(D_TRASHED, null, { deleted_at: 42 });
  await seedDoc(D_ANOMALY, C_ANOMALY);

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
      throw new Error("transact not exercised by doc.add_guest (metadata-only)");
    },
    outbox: () => {
      /* doc.add_guest emits no outbox events */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => frozenNow,
  };
}

function addGuestInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    doc_id: D_LEGACY,
    subject_kind: "user",
    subject_id: NON_MEMBER,
    role: "view",
    ...overrides,
  };
}

/** Parse through the capability's own schema — what the dispatcher does. */
function parsedInput(overrides: Partial<Record<string, unknown>> = {}) {
  return docAddGuest.input.parse(addGuestInput(overrides));
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

describe("doc.add_guest — doc 404s (trash-invisible)", () => {
  it.each([
    ["missing doc", D_MISSING],
    ["soft-deleted doc", D_TRASHED],
    ["cross-tenant doc", D_FOREIGN],
  ])("%s → NotFoundError, nothing minted", async (_label, doc_id) => {
    await expect(
      docAddGuest.handler(buildCtx(user(CREATOR)), parsedInput({ doc_id })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await grantRows()).toEqual([]);
  });
});

describe("doc.add_guest — administer ladder wiring", () => {
  it("creator mints a guest edge; output echoes the full row with is_guest = 1", async () => {
    const out = await docAddGuest.handler(buildCtx(user(CREATOR), 7000), parsedInput());
    expect(out.workspace_id).toBe(WORKSPACE_A);
    expect(out.resource_kind).toBe("doc");
    expect(out.resource_id).toBe(D_LEGACY);
    expect(out.subject_kind).toBe("user");
    expect(out.subject_id).toBe(NON_MEMBER);
    expect(out.role).toBe("view");
    expect(out.is_guest).toBe(1);
    expect(out.created_by).toBe(CREATOR);
    expect(out.created_at).toBe(7000);

    const row = await driver
      .system()
      .selectFrom("grants")
      .selectAll()
      .where("id", "=", out.grant_id)
      .executeTakeFirstOrThrow();
    expect(row.is_guest).toBe(1);
    expect(row.role).toBe("view");
  });

  it("plain member (no owner-tier rung) → acl_deny", async () => {
    const err = await docAddGuest
      .handler(buildCtx(user(PLAIN_MEMBER)), parsedInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    if (err instanceof PermissionDeniedError) {
      expect(err.reason).toEqual({ kind: "acl_deny", scope: { doc_id: D_LEGACY } });
    }
    expect(await grantRows()).toEqual([]);
  });

  it("admin backstop administers a legacy doc", async () => {
    const out = await docAddGuest.handler(buildCtx(user(ADMIN, ["admin"])), parsedInput());
    expect(out.is_guest).toBe(1);
    expect(out.created_by).toBe(ADMIN);
  });

  it("personal-space doc: locked to its owner — even an admin gets acl_deny", async () => {
    await expect(
      docAddGuest.handler(
        buildCtx(user(ADMIN, ["admin"])),
        parsedInput({ doc_id: D_PERSONAL, subject_id: PLAIN_MEMBER }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const out = await docAddGuest.handler(
      buildCtx(user(PERSONAL_OWNER)),
      parsedInput({ doc_id: D_PERSONAL, subject_id: PLAIN_MEMBER }),
    );
    expect(out.is_guest).toBe(1);
  });
});

describe("doc.add_guest — the deliberate asymmetries with permission.grant", () => {
  it("non-member subject is ACCEPTED (permission.grant refuses this exact flow)", async () => {
    // NON_MEMBER has no workspace_members row at all — the guest edge
    // is precisely how someone outside the Org's baseline gets reach.
    const out = await docAddGuest.handler(buildCtx(user(CREATOR)), parsedInput());
    expect(out.subject_id).toBe(NON_MEMBER);
    expect(out.is_guest).toBe(1);
  });

  it("member WITHOUT space standing is accepted on a closed-space doc", async () => {
    // permission.grant throws subject_lacks_space_standing here and
    // routes to THIS verb — the ceiling crossing is the point, and the
    // is_guest marker keeps it audited.
    const out = await docAddGuest.handler(
      buildCtx(user(CREATOR)),
      parsedInput({ doc_id: D_CLOSED, subject_id: PLAIN_MEMBER }),
    );
    expect(out.resource_id).toBe(D_CLOSED);
    expect(out.is_guest).toBe(1);
  });

  it("agent subject is accepted (no agents table yet — recorded debt for BOTH subject kinds)", async () => {
    const out = await docAddGuest.handler(
      buildCtx(user(CREATOR)),
      parsedInput({ subject_kind: "agent", subject_id: BOT }),
    );
    expect(out.subject_kind).toBe("agent");
    expect(out.is_guest).toBe(1);
  });

  it("anomalous placement does NOT refuse — owner-tier recovery sharing stays available", async () => {
    // permission.grant refuses D_ANOMALY outright (unmarked-crossing
    // hazard). The guest edge carries its marker by construction, so
    // mid-anomaly sharing is exactly this verb's reserved job.
    const out = await docAddGuest.handler(
      buildCtx(user(CREATOR)),
      parsedInput({ doc_id: D_ANOMALY }),
    );
    expect(out.resource_id).toBe(D_ANOMALY);
    expect(out.is_guest).toBe(1);
  });

  it("anomaly placement still bounds WHO: admin backstop collapses to owner-tier → acl_deny", async () => {
    await expect(
      docAddGuest.handler(buildCtx(user(ADMIN, ["admin"])), parsedInput({ doc_id: D_ANOMALY })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("doc.add_guest — upsert branches", () => {
  it("existing NON-guest edge → GrantLifecycleConflictError routing to permission.revoke", async () => {
    await db
      .insertInto("grants")
      .values({
        id: G_NONGUEST,
        workspace_id: WORKSPACE_A,
        resource_kind: "doc",
        resource_id: D_LEGACY,
        subject_kind: "user",
        subject_id: PLAIN_MEMBER,
        role: "edit",
        is_guest: 0,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();

    const err = await docAddGuest
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

    // The standing-backed edge is untouched — no role flip, no is_guest flip.
    const row = await driver
      .system()
      .selectFrom("grants")
      .selectAll()
      .where("id", "=", G_NONGUEST)
      .executeTakeFirstOrThrow();
    expect(row.role).toBe("edit");
    expect(row.is_guest).toBe(0);
  });

  it("idempotent same-role re-add: echoes the row, writes nothing", async () => {
    const first = await docAddGuest.handler(buildCtx(user(CREATOR), 7000), parsedInput());
    const again = await docAddGuest.handler(buildCtx(user(CREATOR), 9000), parsedInput());

    expect(again).toEqual(first); // same grant_id, ORIGINAL created_at (7000)
    const rows = await grantRows();
    expect(rows.filter((r) => r.resource_id === D_LEGACY)).toHaveLength(1);
  });

  it("role convergence: same grant_id, role updated, attribution immutable", async () => {
    const first = await docAddGuest.handler(buildCtx(user(CREATOR), 7000), parsedInput());
    const converged = await docAddGuest.handler(
      buildCtx(user(ADMIN, ["admin"]), 9000),
      parsedInput({ role: "edit" }),
    );

    expect(converged.grant_id).toBe(first.grant_id);
    expect(converged.role).toBe("edit");
    expect(converged.created_by).toBe(CREATOR);
    expect(converged.created_at).toBe(7000);
    expect(converged.is_guest).toBe(1);
  });

  it("race shape: guest INSERT ON CONFLICT (unique edge) DO NOTHING yields zero rows on a taken edge", async () => {
    await docAddGuest.handler(buildCtx(user(CREATOR)), parsedInput());

    const result = await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f3"),
        workspace_id: WORKSPACE_A,
        resource_kind: "doc",
        resource_id: D_LEGACY,
        subject_kind: "user",
        subject_id: NON_MEMBER,
        role: "edit",
        is_guest: 1,
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
});

describe("doc.add_guest — attribution (resolveCreatedBy)", () => {
  it("delegated agent attributes to acting_as (not owner_user_id); authority is the DELEGATOR's", async () => {
    // acting_as = CREATOR administers D_LEGACY as its creator (the
    // ceiling evaluates delegated agents as their delegator); the
    // owner_user_id is a DIFFERENT user to prove acting_as wins the
    // attribution.
    const out = await docAddGuest.handler(buildCtx(bot(CREATOR, ADMIN)), parsedInput());
    expect(out.created_by).toBe(CREATOR);
  });

  it("api-key agent attributes to owner_user_id; authority needs the agent's OWN owner-role grant", async () => {
    // An api-key agent evaluates as ITSELF (owner_user_id confers
    // attribution, never authority — and the admin backstop fails
    // closed for agents), so administer requires a non-guest
    // owner-role grant on the doc with the agent as subject.
    await db
      .insertInto("grants")
      .values({
        id: GrantId("018f0000-0000-7000-8000-0000000000f8"),
        workspace_id: WORKSPACE_A,
        resource_kind: "doc",
        resource_id: D_LEGACY,
        subject_kind: "agent",
        subject_id: BOT,
        role: "owner",
        is_guest: 0,
        created_by: CREATOR,
        created_at: 1,
      })
      .execute();
    const out = await docAddGuest.handler(buildCtx(bot(undefined, CREATOR)), parsedInput());
    expect(out.created_by).toBe(CREATOR);
  });

  it("workspace-owned agent (no acting_as, null owner) → unattributable_agent", async () => {
    const err = await docAddGuest
      .handler(buildCtx(bot(undefined, null)), parsedInput())
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("unattributable_agent");
    }
  });
});

// ── Input validation rails ────────────────────────────────────────────────

describe("doc.add_guest — input rails", () => {
  it.each([
    ["guest owner role (unmintable by schema)", addGuestInput({ role: "owner" })],
    ["unknown role", addGuestInput({ role: "superuser" })],
    ["non-UUIDv7 doc_id", addGuestInput({ doc_id: "not-a-uuid" })],
    ["unknown subject_kind", addGuestInput({ subject_kind: "team" })],
    ["empty subject_id", addGuestInput({ subject_id: "" })],
    ["whitespace-only subject_id", addGuestInput({ subject_id: "   " })],
    [
      "missing role",
      (() => {
        const { role: _role, ...rest } = addGuestInput();
        return rest;
      })(),
    ],
    ["unknown top-level key", addGuestInput({ is_guest: 0 })],
  ])("rejects %s", (_label, input) => {
    expect(docAddGuest.input.safeParse(input).success).toBe(false);
  });
});

// ── Metadata-only enrolment + registry metadata ──────────────────────────

describe("doc.add_guest — registry + audit wiring", () => {
  it("is registered in METADATA_ONLY_CAPABILITIES", () => {
    expect(isMetadataOnlyCapability("doc.add_guest")).toBe(true);
  });

  it("declares the correct registry metadata", () => {
    expect(docAddGuest.id).toBe("doc.add_guest");
    expect(docAddGuest.category).toBe("mutation");
    expect(docAddGuest.requires).toEqual(["permission:grant"]);
    expect(docAddGuest.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(docAddGuest.agentAllowed).toEqual({});
  });

  it("projects the DOC as the audit subject", () => {
    expect(docAddGuest.audit.subjectFrom(parsedInput())).toEqual({
      kind: "doc",
      id: D_LEGACY,
    });
  });

  it("emits acl.grant mirroring GrantState exactly (no created_at)", () => {
    const output = {
      grant_id: GrantId("018f0000-0000-7000-8000-0000000000f4"),
      workspace_id: WORKSPACE_A,
      resource_kind: "doc" as const,
      resource_id: D_LEGACY,
      subject_kind: "user" as const,
      subject_id: NON_MEMBER,
      role: "view" as const,
      is_guest: 1 as const,
      created_by: CREATOR,
      created_at: 7000,
    };
    const effect = docAddGuest.audit.effectOnAllow(parsedInput(), output);
    expect(effect).toEqual({
      kind: "acl.grant",
      grant_id: output.grant_id,
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
    const effect = docAddGuest.audit.effectOnDeny(parsedInput(), {
      kind: "missing_scope",
      required: ["permission:grant"],
      principal_scopes: [],
    });
    expect(effect).toEqual({
      kind: "deny",
      capability: "doc.add_guest",
      required_scopes: ["permission:grant"],
      reason_code: "missing_scope",
    });
  });

  it("projects HandlerError kinds via projectErrorAudit", () => {
    const effect = docAddGuest.audit.effectOnError(parsedInput(), { kind: "conflict" });
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.capability).toBe("doc.add_guest");
      expect(effect.error_code).toBe("conflict");
    }
  });

  it("declares a non-collapsing audit policy", () => {
    expect(docAddGuest.audit.collapsePolicy).toEqual({ collapsible: false });
  });
});
