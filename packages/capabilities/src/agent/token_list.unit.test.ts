/**
 * `agent.token_list` unit suite — real in-memory SQLite.
 *
 * Pins: visibility rides the AGENT'S visibility (owner-or-admin,
 * folded to 404), the secret boundary in schema form (no `token_hash`
 * on any output row — even though the projection reads the table that
 * stores it), revoked/expired rows included, revoked AGENTS' tokens
 * still listable (forensics), and `created_at ASC` ordering.
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
import type { Principal, UserPrincipal } from "@editorzero/principal";
import type { Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { agentTokenList } from "./token_list";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const MEMBER = UserId("018f0000-0000-7000-8000-0000000000a3");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const MISSING_BOT = AgentId("018f0000-0000-7000-8000-0000000000b9");
const TOK_EARLY = TokenId("018f0000-0000-7000-8000-0000000000c1");
const TOK_LATE = TokenId("018f0000-0000-7000-8000-0000000000c2");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(AGENTS_DDL);
  driver.exec(AGENT_TOKENS_DDL);
  db = driver.scoped(WORKSPACE_A);
  // BOT anchored to MEMBER. Two tokens: late-minted live, early-minted
  // revoked+expiring — both must list.
  await db
    .insertInto("agents")
    .values({
      id: BOT,
      workspace_id: WORKSPACE_A,
      name: "bot",
      owner_user_id: MEMBER,
      created_by: MEMBER,
      created_at: 1000,
      updated_at: 1000,
      revoked_at: null,
    })
    .execute();
  await seedToken(TOK_LATE, 3000, null, null);
  await seedToken(TOK_EARLY, 1000, 2000, 9000);
});

afterEach(async () => {
  await driver.close();
});

async function seedToken(
  id: TokenId,
  created_at: number,
  revoked_at: number | null,
  expires_at: number | null,
) {
  await db
    .insertInto("agent_tokens")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      agent_id: BOT,
      token_hash: `fixture-hash-${id.slice(-2)}`,
      token_prefix: "ez_agent_abc",
      last4: "wxyz",
      scopes: JSON.stringify(["workspace:read"]),
      tier: "read-only",
      created_by: MEMBER,
      created_at,
      expires_at,
      revoked_at,
    })
    .execute();
}

function user(id: UserId, roles: readonly Role[]): UserPrincipal {
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
      /* reads enqueue nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => 5000,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("agent.token_list — the displayable record", () => {
  it("lists oldest-first; revoked + expiring rows included; NO token_hash on any row", async () => {
    const out = await agentTokenList.handler(
      buildCtx(user(MEMBER, ["member"])),
      agentTokenList.input.parse({ agent_id: BOT }),
    );
    expect(out.tokens.map((t) => t.token_id)).toEqual([TOK_EARLY, TOK_LATE]);
    expect(out.tokens[0]?.revoked_at).toBe(2000);
    expect(out.tokens[0]?.expires_at).toBe(9000);
    expect(out.tokens[1]?.revoked_at).toBeNull();
    for (const t of out.tokens) {
      expect(t).not.toHaveProperty("token_hash");
      expect(t).not.toHaveProperty("token");
    }
  });

  it("a revoked AGENT's tokens still list (forensics — what did the dead identity hold)", async () => {
    await db.updateTable("agents").set({ revoked_at: 4000 }).where("id", "=", BOT).execute();
    const out = await agentTokenList.handler(
      buildCtx(user(ADMIN, ["admin"])),
      agentTokenList.input.parse({ agent_id: BOT }),
    );
    expect(out.tokens).toHaveLength(2);
  });
});

describe("agent.token_list — visibility rides the agent's", () => {
  it("a non-admin who cannot see the agent gets 404 (never 403, never an empty list)", async () => {
    await expect(
      agentTokenList.handler(
        buildCtx(user(ADMIN, ["member"])),
        agentTokenList.input.parse({ agent_id: BOT }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("missing agent → 404", async () => {
    await expect(
      agentTokenList.handler(
        buildCtx(user(ADMIN, ["admin"])),
        agentTokenList.input.parse({ agent_id: MISSING_BOT }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
