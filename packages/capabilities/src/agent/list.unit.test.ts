/**
 * `agent.list` unit suite — real in-memory SQLite.
 *
 * Pins the visibility PARTITION (admin-tier sees all; others see
 * agents anchored to them), revoked-rows-included, and the
 * registration ordering (`created_at ASC, id ASC` — names are mutable
 * and freed on revoke, so name-order would shuffle under renames).
 */

import {
  AGENT_TOKENS_DDL,
  AGENTS_DDL,
  createSqliteDriver,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import type { Role, Scope } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { agentList } from "./list";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const OTHER_MEMBER = UserId("018f0000-0000-7000-8000-0000000000a4");
const BOT_EARLY = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_LATE = AgentId("018f0000-0000-7000-8000-0000000000b2");
const BOT_REVOKED = AgentId("018f0000-0000-7000-8000-0000000000b3");
const OTHER_BOT = AgentId("018f0000-0000-7000-8000-0000000000b4");
const CALLER_BOT = AgentId("018f0000-0000-7000-8000-0000000000b5");
const CALLER_TOKEN = TokenId("018f0000-0000-7000-8000-0000000000bb");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(AGENTS_DDL);
  driver.exec(AGENT_TOKENS_DDL);
  db = driver.scoped(WORKSPACE_A);
  // MEMBER anchors three (one revoked, distinct created_at for the
  // ordering pin); OTHER_MEMBER anchors one.
  await seedAgent(BOT_LATE, MEMBER, 3000);
  await seedAgent(BOT_EARLY, MEMBER, 1000);
  await seedAgent(BOT_REVOKED, MEMBER, 2000, 4000);
  await seedAgent(OTHER_BOT, OTHER_MEMBER, 1500);
});

afterEach(async () => {
  await driver.close();
});

async function seedAgent(
  id: AgentId,
  owner: UserId,
  created_at: number,
  revoked_at: number | null = null,
) {
  await db
    .insertInto("agents")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      name: `bot-${id.slice(-2)}`,
      owner_user_id: owner,
      created_by: owner,
      created_at,
      updated_at: created_at,
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

describe("agent.list — partition + ordering", () => {
  it("admin-tier user sees every agent (revoked included), registration-ordered", async () => {
    const out = await agentList.handler(
      buildCtx(user(ADMIN, ["admin"])),
      agentList.input.parse({}),
    );
    expect(out.agents.map((a) => a.agent_id)).toEqual([
      BOT_EARLY,
      OTHER_BOT,
      BOT_REVOKED,
      BOT_LATE,
    ]);
    const revoked = out.agents.find((a) => a.agent_id === BOT_REVOKED);
    expect(revoked?.revoked_at).toBe(4000);
  });

  it("non-admin member sees ONLY agents anchored to them", async () => {
    const out = await agentList.handler(
      buildCtx(user(MEMBER, ["member"])),
      agentList.input.parse({}),
    );
    expect(out.agents.map((a) => a.agent_id)).toEqual([BOT_EARLY, BOT_REVOKED, BOT_LATE]);
  });

  it("agent caller: workspace:admin scope widens to all; without it, anchor-scoped", async () => {
    const wide = await agentList.handler(
      buildCtx(agentPrincipal(OTHER_MEMBER, ["workspace:read", "workspace:admin"])),
      agentList.input.parse({}),
    );
    expect(wide.agents).toHaveLength(4);

    const narrow = await agentList.handler(
      buildCtx(agentPrincipal(OTHER_MEMBER, ["workspace:read"])),
      agentList.input.parse({}),
    );
    expect(narrow.agents.map((a) => a.agent_id)).toEqual([OTHER_BOT]);
  });

  it("a caller anchoring nothing gets an empty list, not an error", async () => {
    const out = await agentList.handler(
      buildCtx(user(UserId("018f0000-0000-7000-8000-0000000000af"), ["member"])),
      agentList.input.parse({}),
    );
    expect(out.agents).toEqual([]);
  });
});
