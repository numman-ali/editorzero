/**
 * `agent.token_revoke` unit suite — real in-memory SQLite.
 *
 * Pins the SCOPED kill (one token; the agent and sibling tokens stay
 * live), the terminal re-revoke refusal, and the minimal
 * `{token_id, revoked_at}` echo + audit effect.
 */

import {
  AGENT_TOKENS_DDL,
  AGENTS_DDL,
  createSqliteDriver,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import { NotFoundError, ValidationError } from "@editorzero/errors";
import { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability, type Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { agentTokenRevoke } from "./token_revoke";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const TOK = TokenId("018f0000-0000-7000-8000-0000000000c1");
const SIBLING_TOK = TokenId("018f0000-0000-7000-8000-0000000000c2");
const MISSING_TOK = TokenId("018f0000-0000-7000-8000-0000000000c9");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(AGENTS_DDL);
  driver.exec(AGENT_TOKENS_DDL);
  db = driver.scoped(WORKSPACE_A);
  await db
    .insertInto("agents")
    .values({
      id: BOT,
      workspace_id: WORKSPACE_A,
      name: "bot",
      owner_user_id: ADMIN,
      created_by: ADMIN,
      created_at: 1000,
      updated_at: 1000,
      revoked_at: null,
    })
    .execute();
  for (const id of [TOK, SIBLING_TOK]) {
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
        tier: "custom",
        created_by: ADMIN,
        created_at: 1000,
        expires_at: null,
        revoked_at: null,
      })
      .execute();
  }
});

afterEach(async () => {
  await driver.close();
});

function user(id: UserId, roles: readonly Role[] = ["admin"]): UserPrincipal {
  return { kind: "user", id, workspace_id: WORKSPACE_A, roles, session_id: null, token_id: null };
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
      /* agent.token_revoke enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => now,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("agent.token_revoke — the scoped kill", () => {
  it("revokes ONE token: minimal echo; the agent and the sibling stay live", async () => {
    const out = await agentTokenRevoke.handler(
      buildCtx(user(ADMIN), 7000),
      agentTokenRevoke.input.parse({ token_id: TOK }),
    );
    expect(out).toEqual({ token_id: TOK, revoked_at: 7000 });

    const killed = await db
      .selectFrom("agent_tokens")
      .selectAll()
      .where("id", "=", TOK)
      .executeTakeFirst();
    expect(killed?.revoked_at).toBe(7000);

    const sibling = await db
      .selectFrom("agent_tokens")
      .selectAll()
      .where("id", "=", SIBLING_TOK)
      .executeTakeFirst();
    expect(sibling?.revoked_at).toBeNull();

    const agent = await db
      .selectFrom("agents")
      .selectAll()
      .where("id", "=", BOT)
      .executeTakeFirst();
    expect(agent?.revoked_at).toBeNull();
  });

  it("re-revoke → token_revoked refusal; the FIRST kill clock survives", async () => {
    await agentTokenRevoke.handler(
      buildCtx(user(ADMIN), 7000),
      agentTokenRevoke.input.parse({ token_id: TOK }),
    );
    const err = await agentTokenRevoke
      .handler(buildCtx(user(ADMIN), 9000), agentTokenRevoke.input.parse({ token_id: TOK }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("token_revoked");
    }
    const row = await db
      .selectFrom("agent_tokens")
      .selectAll()
      .where("id", "=", TOK)
      .executeTakeFirst();
    expect(row?.revoked_at).toBe(7000);
  });

  it("missing token → 404", async () => {
    await expect(
      agentTokenRevoke.handler(
        buildCtx(user(ADMIN)),
        agentTokenRevoke.input.parse({ token_id: MISSING_TOK }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("agent.token_revoke — projections + registry facts", () => {
  it("audit effect carries the kill clock verbatim", async () => {
    const input = agentTokenRevoke.input.parse({ token_id: TOK });
    const out = await agentTokenRevoke.handler(buildCtx(user(ADMIN), 7000), input);
    expect(agentTokenRevoke.audit.effectOnAllow(input, out)).toEqual({
      kind: "agent.token_revoke",
      token_id: TOK,
      revoked_at: 7000,
    });
  });

  it("is METADATA_ONLY (dispatcher-tx lane; invariant 7)", () => {
    expect(isMetadataOnlyCapability(agentTokenRevoke.id)).toBe(true);
  });
});
