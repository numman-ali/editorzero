/**
 * `space.create` unit suite — real in-memory SQLite.
 *
 * Creation has NO handler-internal authority: the `workspace:admin` L1
 * scope is the bound (dispatcher gate territory), so this suite pins
 * the handler semantics — team-only minting, slug derivation +
 * collision, attribution, registry/audit projections. The
 * member-cannot-create pin is the `requires` metadata + the gate's
 * generic scope enforcement.
 */

import {
  createSqliteDriver,
  SPACES_DDL,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import { SlugCollisionError, ValidationError } from "@editorzero/errors";
import { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { spaceCreate } from "./create";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const DELEGATOR = UserId("018f0000-0000-7000-8000-0000000000a8");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SPACES_DDL);
  db = driver.scoped(WORKSPACE_A);
});

afterEach(async () => {
  await driver.close();
});

function user(id: UserId, roles: readonly Role[] = ["admin"]): UserPrincipal {
  return { kind: "user", id, workspace_id: WORKSPACE_A, roles, session_id: null, token_id: null };
}

function agent(acting_as?: UserId): AgentPrincipal {
  return {
    kind: "agent",
    id: BOT,
    workspace_id: WORKSPACE_A,
    owner_user_id: acting_as === undefined ? null : DELEGATOR,
    scopes: ["workspace:admin"],
    token_id: BOT_TOKEN,
    token_kind: acting_as === undefined ? "api-key" : "agent-auth",
    ...(acting_as !== undefined && { acting_as }),
  };
}

function buildCtx(principal: Principal, now = 5000): CapabilityContext {
  return {
    principal,
    tenant: { workspace_id: WORKSPACE_A },
    db,
    transact: async () => {
      throw new Error("metadata-only capability must not call ctx.transact");
    },
    outbox: () => {
      /* space.create enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => now,
  };
}

function createInput(overrides: Partial<Record<string, unknown>> = {}) {
  return spaceCreate.input.parse({
    name: "Design Team",
    space_type: "closed",
    ...overrides,
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("space.create — minting", () => {
  it("creates a TEAM space: kind pinned, owner null, slug derived, baseline defaulted", async () => {
    const out = await spaceCreate.handler(buildCtx(user(ADMIN), 7000), createInput());

    expect(out.kind).toBe("team");
    expect(out.owner_user_id).toBeNull();
    expect(out.name).toBe("Design Team");
    expect(out.slug).toBe("design-team");
    expect(out.type).toBe("closed");
    expect(out.baseline_access).toBe("view");
    expect(out.workspace_id).toBe(WORKSPACE_A);
    expect(out.created_by).toBe(ADMIN);
    expect(out.created_at).toBe(7000);
    expect(out.updated_at).toBe(7000);
    expect(out.deleted_at).toBeNull();

    const rows = await db.selectFrom("spaces").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(out.space_id);
    expect(rows[0]?.kind).toBe("team");
    expect(rows[0]?.owner_user_id).toBeNull();
  });

  it("respects an explicit baseline_access", async () => {
    const out = await spaceCreate.handler(
      buildCtx(user(ADMIN)),
      createInput({ space_type: "open", baseline_access: "edit" }),
    );
    expect(out.type).toBe("open");
    expect(out.baseline_access).toBe("edit");
  });

  it("slugifies unicode/punctuation and falls back to 'untitled'", async () => {
    const fancy = await spaceCreate.handler(
      buildCtx(user(ADMIN)),
      createInput({ name: "Café & Friends!" }),
    );
    expect(fancy.slug).toBe("cafe-friends");

    const bare = await spaceCreate.handler(buildCtx(user(ADMIN)), createInput({ name: "!!!" }));
    expect(bare.slug).toBe("untitled");
  });

  it("live slug collision → typed 409; a trashed space does not block reuse", async () => {
    await spaceCreate.handler(buildCtx(user(ADMIN)), createInput());
    await expect(
      spaceCreate.handler(buildCtx(user(ADMIN)), createInput({ name: "design team" })),
    ).rejects.toBeInstanceOf(SlugCollisionError);

    // Trash the live row → the partial unique index frees the slug.
    await db
      .updateTable("spaces")
      .set({ deleted_at: 42 })
      .where("slug", "=", "design-team")
      .execute();
    const reused = await spaceCreate.handler(buildCtx(user(ADMIN)), createInput());
    expect(reused.slug).toBe("design-team");
  });

  it("delegated agent attributes created_by to acting_as; unattributable agent refused", async () => {
    const out = await spaceCreate.handler(buildCtx(agent(DELEGATOR)), createInput());
    expect(out.created_by).toBe(DELEGATOR);

    const bare: AgentPrincipal = {
      kind: "agent",
      id: BOT,
      workspace_id: WORKSPACE_A,
      owner_user_id: null,
      scopes: ["workspace:admin"],
      token_id: BOT_TOKEN,
      token_kind: "api-key",
    };
    await expect(spaceCreate.handler(buildCtx(bare), createInput())).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("space.create — input rails", () => {
  it.each([
    ["empty name", { name: "" }],
    ["whitespace name", { name: "   " }],
    ["unknown key", { kind: "personal" }],
    ["bad space_type", { space_type: "secret" }],
    ["owner baseline (outside the CHECK subset)", { baseline_access: "owner" }],
  ])("%s → schema rejects", (_label, overrides) => {
    expect(() => createInput(overrides)).toThrow();
  });
});

describe("space.create — registry + audit wiring", () => {
  it("declares the correct registry metadata", () => {
    expect(spaceCreate.id).toBe("space.create");
    expect(spaceCreate.category).toBe("mutation");
    expect(spaceCreate.requires).toEqual(["workspace:admin"]);
    expect(spaceCreate.agentAllowed).toEqual({});
    expect(spaceCreate.surfaces).toEqual(["api", "cli", "mcp"]);
    expect(spaceCreate.audit.collapsePolicy).toEqual({ collapsible: false });
  });

  it("projects the kind-less space subject (no id exists pre-insert)", () => {
    expect(spaceCreate.audit.subjectFrom(createInput())).toEqual({ kind: "space" });
  });

  it("emits space.create with the kind/type → space_kind/space_type mapping", async () => {
    const out = await spaceCreate.handler(buildCtx(user(ADMIN), 7000), createInput());
    const effect = spaceCreate.audit.effectOnAllow(createInput(), out);
    expect(effect).toEqual({
      kind: "space.create",
      space_id: out.space_id,
      workspace_id: WORKSPACE_A,
      space_kind: "team",
      space_type: "closed",
      owner_user_id: null,
      name: "Design Team",
      slug: "design-team",
      baseline_access: "view",
      created_by: ADMIN,
    });
  });

  it("emits a deny effect carrying the reason code + scope requirement", () => {
    const deny = spaceCreate.audit.effectOnDeny(createInput(), {
      kind: "missing_scope",
      required: ["workspace:admin"],
      principal_scopes: [],
    });
    expect(deny).toEqual({
      kind: "deny",
      capability: "space.create",
      required_scopes: ["workspace:admin"],
      reason_code: "missing_scope",
    });
  });
});
