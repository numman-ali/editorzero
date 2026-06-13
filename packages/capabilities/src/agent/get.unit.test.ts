/**
 * `agent.get` unit suite — real in-memory SQLite.
 *
 * Pins the owner-scoped visibility rule (ADR 0044 Decision 3):
 * admin-tier callers (user owner/admin; agent holding
 * `workspace:admin`) see every agent; everyone else sees only agents
 * anchored to them — enforced as 404, never 403. Revoked agents stay
 * readable (terminal-but-visible). Plus the collapse-key bucketing the
 * type-erased audit boundary forces.
 */

import {
  AGENT_TOKENS_DDL,
  AGENTS_DDL,
  createSqliteDriver,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import { NotFoundError } from "@editorzero/errors";
import { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import type { Role, Scope } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { agentGet } from "./get";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const OTHER_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a4");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const OTHER_BOT = AgentId("018f0000-0000-7000-8000-0000000000b2");
const MISSING_BOT = AgentId("018f0000-0000-7000-8000-0000000000b9");
const CALLER_BOT = AgentId("018f0000-0000-7000-8000-0000000000b5");
const CALLER_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(AGENTS_DDL);
  driver.exec(AGENT_TOKENS_DDL);
  db = driver.scoped(WORKSPACE_A);
  // BOT anchored to MEMBER; OTHER_BOT anchored to OTHER_MEMBER.
  await seedAgent(BOT, MEMBER);
  await seedAgent(OTHER_BOT, OTHER_MEMBER);
});

afterEach(async () => {
  await driver.close();
});

async function seedAgent(id: AgentId, owner: UserId, revoked_at: number | null = null) {
  await db
    .insertInto("agents")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      name: `bot-${id.slice(-2)}`,
      owner_user_id: owner,
      created_by: owner,
      created_at: 1000,
      updated_at: 1000,
      revoked_at,
    })
    .execute();
}

function user(id: UserId, roles: readonly Role[]): UserPrincipal {
  return { kind: "user", id, workspace_id: WORKSPACE_A, roles, session_id: null, token_id: null };
}

function agentPrincipal(owner: UserId, scopes: readonly Scope[]): AgentPrincipal {
  return {
    kind: "agent",
    id: CALLER_BOT,
    workspace_id: WORKSPACE_A,
    owner_user_id: owner,
    scopes,
    token_id: CALLER_TOKEN,
    token_kind: "api-key",
  };
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
      /* reads enqueue nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 5000,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("agent.get — visibility", () => {
  it("admin-tier user reads ANY agent, including one anchored to someone else", async () => {
    const out = await agentGet.handler(
      buildCtx(user(ADMIN, ["admin"])),
      agentGet.input.parse({ agent_id: OTHER_BOT }),
    );
    expect(out.agent_id).toBe(OTHER_BOT);
    expect(out.owner_user_id).toBe(OTHER_MEMBER);
  });

  it("non-admin member reads their own anchored agent", async () => {
    const out = await agentGet.handler(
      buildCtx(user(MEMBER, ["member"])),
      agentGet.input.parse({ agent_id: BOT }),
    );
    expect(out.agent_id).toBe(BOT);
    expect(out.name).toBe(`bot-${BOT.slice(-2)}`);
  });

  it("non-admin member probing someone else's agent → 404 (never 403)", async () => {
    await expect(
      agentGet.handler(
        buildCtx(user(MEMBER, ["member"])),
        agentGet.input.parse({ agent_id: OTHER_BOT }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("agent caller holding workspace:admin sees all; without it, only its anchor's agents", async () => {
    const wide = agentPrincipal(MEMBER, ["workspace:read", "workspace:admin"]);
    const narrow = agentPrincipal(MEMBER, ["workspace:read"]);

    const seen = await agentGet.handler(
      buildCtx(wide),
      agentGet.input.parse({ agent_id: OTHER_BOT }),
    );
    expect(seen.agent_id).toBe(OTHER_BOT);

    const own = await agentGet.handler(buildCtx(narrow), agentGet.input.parse({ agent_id: BOT }));
    expect(own.agent_id).toBe(BOT);

    await expect(
      agentGet.handler(buildCtx(narrow), agentGet.input.parse({ agent_id: OTHER_BOT })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("missing id → 404", async () => {
    await expect(
      agentGet.handler(
        buildCtx(user(ADMIN, ["admin"])),
        agentGet.input.parse({ agent_id: MISSING_BOT }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("agent.get — terminal-but-visible", () => {
  it("a revoked agent still resolves, carrying its kill clock", async () => {
    await db.updateTable("agents").set({ revoked_at: 4000 }).where("id", "=", BOT).execute();
    const out = await agentGet.handler(
      buildCtx(user(ADMIN, ["admin"])),
      agentGet.input.parse({ agent_id: BOT }),
    );
    expect(out.revoked_at).toBe(4000);
  });
});

describe("agent.get — audit collapse bucketing", () => {
  it("collapse key buckets by agent_id; unvalidated input falls back without throwing", () => {
    const policy = agentGet.audit.collapsePolicy;
    if (!policy.collapsible) throw new Error("agent.get must be collapsible");
    expect(policy.collapseKey({ agent_id: BOT })).toBe(`agent.get:${BOT}`);
    expect(policy.collapseKey(null)).toBe("agent.get:unvalidated");
    expect(policy.collapseKey({ agent_id: 42 })).toBe("agent.get:unvalidated");
  });
});
