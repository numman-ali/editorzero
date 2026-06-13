/**
 * `agent.create` unit suite — real in-memory SQLite.
 *
 * The `agent:create` scope bound is dispatcher-gate territory; this
 * suite pins the handler semantics: owner resolution (never an input),
 * the agent→human ownership chain, the unattributable refusal,
 * live-name uniqueness with revoked-name reuse, and the audit
 * projection. Plus the registry/metadata facts the family asserts
 * capability-locally (metadata-only membership).
 */

import {
  AGENT_TOKENS_DDL,
  AGENTS_DDL,
  createSqliteDriver,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import { ConflictError, ValidationError } from "@editorzero/errors";
import { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability, type Role, type Scope } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { agentCreate } from "./create";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const DELEGATOR = UserId("018f0000-0000-7000-8000-0000000000a8");
const BOT_OWNER = UserId("018f0000-0000-7000-8000-0000000000a9");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(AGENTS_DDL);
  driver.exec(AGENT_TOKENS_DDL);
  db = driver.scoped(WORKSPACE_A);
});

afterEach(async () => {
  await driver.close();
});

function user(id: UserId, roles: readonly Role[] = ["admin"]): UserPrincipal {
  return { kind: "user", id, workspace_id: WORKSPACE_A, roles, session_id: null, token_id: null };
}

function agentPrincipal(
  opts: { scopes?: readonly Scope[]; owner?: UserId | null; acting_as?: UserId } = {},
): AgentPrincipal {
  return {
    kind: "agent",
    id: BOT,
    workspace_id: WORKSPACE_A,
    owner_user_id: opts.owner === undefined ? BOT_OWNER : opts.owner,
    scopes: opts.scopes ?? ["workspace:read", "agent:create"],
    token_id: BOT_TOKEN,
    token_kind: opts.acting_as === undefined ? "api-key" : "agent-auth",
    ...(opts.acting_as !== undefined && { acting_as: opts.acting_as }),
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
      /* agent.create enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => now,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("agent.create — minting an identity", () => {
  it("creates: owner = created_by = the calling user; revoked_at null; clocks = now", async () => {
    const out = await agentCreate.handler(
      buildCtx(user(ADMIN), 7000),
      agentCreate.input.parse({ name: "release-bot" }),
    );

    expect(out.name).toBe("release-bot");
    expect(out.workspace_id).toBe(WORKSPACE_A);
    expect(out.owner_user_id).toBe(ADMIN);
    expect(out.created_by).toBe(ADMIN);
    expect(out.created_at).toBe(7000);
    expect(out.updated_at).toBe(7000);
    expect(out.revoked_at).toBeNull();

    const rows = await db.selectFrom("agents").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(out.agent_id);
    expect(rows[0]?.owner_user_id).toBe(ADMIN);
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it("agent-created agent chains to the CREATING agent's owner (no ownerless rows)", async () => {
    const out = await agentCreate.handler(
      buildCtx(agentPrincipal()),
      agentCreate.input.parse({ name: "child-bot" }),
    );
    expect(out.owner_user_id).toBe(BOT_OWNER);
    expect(out.created_by).toBe(BOT_OWNER);
  });

  it("delegated (acting_as) agent anchors to the DELEGATOR, not its own owner", async () => {
    const out = await agentCreate.handler(
      buildCtx(agentPrincipal({ owner: BOT_OWNER, acting_as: DELEGATOR })),
      agentCreate.input.parse({ name: "delegated-child" }),
    );
    expect(out.owner_user_id).toBe(DELEGATOR);
    expect(out.created_by).toBe(DELEGATOR);
  });

  it("unattributable agent (no owner, no acting_as) → unattributable_agent refusal", async () => {
    const err = await agentCreate
      .handler(
        buildCtx(agentPrincipal({ owner: null })),
        agentCreate.input.parse({ name: "orphan" }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("unattributable_agent");
    }
    expect(await db.selectFrom("agents").selectAll().execute()).toHaveLength(0);
  });
});

describe("agent.create — live-name uniqueness", () => {
  it("a live agent's name collides → ConflictError; nothing written", async () => {
    await agentCreate.handler(buildCtx(user(ADMIN)), agentCreate.input.parse({ name: "bot" }));
    await expect(
      agentCreate.handler(buildCtx(user(ADMIN)), agentCreate.input.parse({ name: "bot" })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await db.selectFrom("agents").selectAll().execute()).toHaveLength(1);
  });

  it("a REVOKED agent frees its name — recreate-under-new-id reuses it", async () => {
    const first = await agentCreate.handler(
      buildCtx(user(ADMIN), 1000),
      agentCreate.input.parse({ name: "bot" }),
    );
    await db
      .updateTable("agents")
      .set({ revoked_at: 2000, updated_at: 2000 })
      .where("id", "=", AgentId(first.agent_id))
      .execute();

    const second = await agentCreate.handler(
      buildCtx(user(ADMIN), 3000),
      agentCreate.input.parse({ name: "bot" }),
    );
    expect(second.agent_id).not.toBe(first.agent_id);
    expect(second.name).toBe("bot");
    expect(await db.selectFrom("agents").selectAll().execute()).toHaveLength(2);
  });
});

describe("agent.create — projections + registry facts", () => {
  it("audit effect carries the identity row fields, verbatim", async () => {
    const input = agentCreate.input.parse({ name: "auditable" });
    const out = await agentCreate.handler(buildCtx(user(ADMIN), 9000), input);
    expect(agentCreate.audit.effectOnAllow(input, out)).toEqual({
      kind: "agent.create",
      agent_id: out.agent_id,
      workspace_id: WORKSPACE_A,
      name: "auditable",
      owner_user_id: ADMIN,
      created_by: ADMIN,
    });
  });

  it("is METADATA_ONLY (dispatcher-tx lane; invariant 7)", () => {
    expect(isMetadataOnlyCapability(agentCreate.id)).toBe(true);
  });

  it("input schema: trims, refuses empty and >120-char names, refuses unknown keys", () => {
    expect(agentCreate.input.parse({ name: "  padded  " })).toEqual({ name: "padded" });
    expect(() => agentCreate.input.parse({ name: "   " })).toThrow();
    expect(() => agentCreate.input.parse({ name: "x".repeat(121) })).toThrow();
    expect(() => agentCreate.input.parse({ name: "ok", owner_user_id: ADMIN })).toThrow();
  });
});
