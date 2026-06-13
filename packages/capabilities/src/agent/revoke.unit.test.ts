/**
 * `agent.revoke` unit suite — real in-memory SQLite.
 *
 * Pins the TERMINAL posture (ADR 0044 Decision 2): re-revoke is
 * refused (the first kill clock is THE record), token rows are NOT
 * retro-patched (revocation cascades by resolver-side conjunction,
 * not by walking rows), and the minimal `{agent_id, revoked_at}`
 * echo + audit effect.
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
import { agentRevoke } from "./revoke";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const MISSING_BOT = AgentId("018f0000-0000-7000-8000-0000000000b9");
const TOK = TokenId("018f0000-0000-7000-8000-0000000000c1");

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
  await db
    .insertInto("agent_tokens")
    .values({
      id: TOK,
      workspace_id: WORKSPACE_A,
      agent_id: BOT,
      token_hash: "fixture-hash-c1",
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
      /* agent.revoke enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => now,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("agent.revoke — the kill", () => {
  it("revokes: minimal echo {agent_id, revoked_at: now}; row stamped, still present", async () => {
    const out = await agentRevoke.handler(
      buildCtx(user(ADMIN), 7000),
      agentRevoke.input.parse({ agent_id: BOT }),
    );
    expect(out).toEqual({ agent_id: BOT, revoked_at: 7000 });

    const row = await db.selectFrom("agents").selectAll().where("id", "=", BOT).executeTakeFirst();
    expect(row?.revoked_at).toBe(7000);
    expect(row?.updated_at).toBe(7000);
  });

  it("token rows are NOT retro-patched — the kill is a resolver-side conjunction", async () => {
    await agentRevoke.handler(
      buildCtx(user(ADMIN), 7000),
      agentRevoke.input.parse({ agent_id: BOT }),
    );
    const token = await db
      .selectFrom("agent_tokens")
      .selectAll()
      .where("id", "=", TOK)
      .executeTakeFirst();
    expect(token?.revoked_at).toBeNull();
  });

  it("re-revoke → agent_revoked refusal; the FIRST kill clock survives", async () => {
    await agentRevoke.handler(
      buildCtx(user(ADMIN), 7000),
      agentRevoke.input.parse({ agent_id: BOT }),
    );
    const err = await agentRevoke
      .handler(buildCtx(user(ADMIN), 9000), agentRevoke.input.parse({ agent_id: BOT }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("agent_revoked");
    }
    const row = await db.selectFrom("agents").selectAll().where("id", "=", BOT).executeTakeFirst();
    expect(row?.revoked_at).toBe(7000);
  });

  it("missing agent → 404", async () => {
    await expect(
      agentRevoke.handler(
        buildCtx(user(ADMIN)),
        agentRevoke.input.parse({ agent_id: MISSING_BOT }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("agent.revoke — projections + registry facts", () => {
  it("audit effect carries the kill clock verbatim", async () => {
    const input = agentRevoke.input.parse({ agent_id: BOT });
    const out = await agentRevoke.handler(buildCtx(user(ADMIN), 7000), input);
    expect(agentRevoke.audit.effectOnAllow(input, out)).toEqual({
      kind: "agent.revoke",
      agent_id: BOT,
      revoked_at: 7000,
    });
  });

  it("is METADATA_ONLY (dispatcher-tx lane; invariant 7)", () => {
    expect(isMetadataOnlyCapability(agentRevoke.id)).toBe(true);
  });
});
