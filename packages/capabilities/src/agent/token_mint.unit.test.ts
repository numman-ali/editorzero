/**
 * `agent.token_mint` unit suite — real in-memory SQLite.
 *
 * THE security-critical verb. Pins: show-once secret discipline (the
 * plaintext exists in the output alone; the row stores the SHA-256;
 * the audit effect structurally excludes both), tier→scopes expansion
 * to an EXPLICIT stored list, the tier↔scopes input contract, the
 * caller-relative non-amplification rung (agent minters mint ⊆ their
 * own scopes; humans skip the rung), liveness (no re-credentialing the
 * dead), and expiry sanity against the handler clock.
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
import type { AgentPrincipal, Principal, UserPrincipal } from "@editorzero/principal";
import {
  AGENT_SCOPE_TIERS,
  isMetadataOnlyCapability,
  type Role,
  type Scope,
} from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { agentTokenMint } from "./token_mint";
import { AGENT_TOKEN_LENGTH, AGENT_TOKEN_PREFIX, hashAgentToken } from "./token-crypto";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const DELEGATOR = UserId("018f0000-0000-7000-8000-0000000000a8");
const BOT_OWNER = UserId("018f0000-0000-7000-8000-0000000000a9");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_REVOKED = AgentId("018f0000-0000-7000-8000-0000000000b2");
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
  await seedAgent(BOT, null);
  await seedAgent(BOT_REVOKED, 2000);
});

afterEach(async () => {
  await driver.close();
});

async function seedAgent(id: AgentId, revoked_at: number | null) {
  await db
    .insertInto("agents")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      name: `bot-${id.slice(-2)}`,
      owner_user_id: ADMIN,
      created_by: ADMIN,
      created_at: 1000,
      updated_at: 1000,
      revoked_at,
    })
    .execute();
}

function user(id: UserId, roles: readonly Role[] = ["admin"]): UserPrincipal {
  return { kind: "user", id, workspace_id: WORKSPACE_A, roles, session_id: null, token_id: null };
}

function agentPrincipal(
  opts: { scopes?: readonly Scope[]; acting_as?: UserId } = {},
): AgentPrincipal {
  return {
    kind: "agent",
    id: CALLER_BOT,
    workspace_id: WORKSPACE_A,
    owner_user_id: BOT_OWNER,
    scopes: opts.scopes ?? ["workspace:read", "agent:create"],
    token_id: CALLER_TOKEN,
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
      /* agent.token_mint enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => now,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("agent.token_mint — show-once secret discipline", () => {
  it("the output alone carries the plaintext; the row stores ONLY the SHA-256", async () => {
    const out = await agentTokenMint.handler(
      buildCtx(user(ADMIN), 5000),
      agentTokenMint.input.parse({ agent_id: BOT, tier: "custom", scopes: ["workspace:read"] }),
    );

    expect(out.token).toHaveLength(AGENT_TOKEN_LENGTH);
    expect(out.token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(out.token_prefix).toBe(out.token.slice(0, 12));
    expect(out.last4).toBe(out.token.slice(-4));

    const row = await db
      .selectFrom("agent_tokens")
      .selectAll()
      .where("id", "=", TokenId(out.token_id))
      .executeTakeFirst();
    expect(row?.token_hash).toBe(hashAgentToken(out.token));
    expect(row?.token_hash).not.toBe(out.token);
    expect(JSON.stringify(row)).not.toContain(out.token);
  });

  it("the audit effect is built from ROW fields — no token, no hash, by shape", async () => {
    const input = agentTokenMint.input.parse({
      agent_id: BOT,
      tier: "custom",
      scopes: ["workspace:read", "doc:read"],
    });
    const out = await agentTokenMint.handler(buildCtx(user(ADMIN), 5000), input);
    const effect = agentTokenMint.audit.effectOnAllow(input, out);
    expect(effect).toEqual({
      kind: "agent.token_mint",
      token_id: out.token_id,
      agent_id: BOT,
      workspace_id: WORKSPACE_A,
      token_prefix: out.token_prefix,
      last4: out.last4,
      scopes: ["workspace:read", "doc:read"],
      tier: "custom",
      expires_at: null,
      created_by: ADMIN,
    });
    expect(effect).not.toHaveProperty("token");
    expect(effect).not.toHaveProperty("token_hash");
    expect(JSON.stringify(effect)).not.toContain(out.token);
  });
});

describe("agent.token_mint — tier → scopes", () => {
  it("a named tier expands to the EXPLICIT stored list (no tier indirection in rows)", async () => {
    const out = await agentTokenMint.handler(
      buildCtx(user(ADMIN)),
      agentTokenMint.input.parse({ agent_id: BOT, tier: "author" }),
    );
    expect(out.scopes).toEqual([...AGENT_SCOPE_TIERS.author]);
    expect(out.tier).toBe("author");

    const row = await db
      .selectFrom("agent_tokens")
      .select(["scopes"])
      .where("id", "=", TokenId(out.token_id))
      .executeTakeFirst();
    expect(row === undefined ? undefined : JSON.parse(row.scopes)).toEqual([
      ...AGENT_SCOPE_TIERS.author,
    ]);
  });

  it("input contract: named tier + scopes = ambiguous; custom without scopes = refused", () => {
    expect(() =>
      agentTokenMint.input.parse({ agent_id: BOT, tier: "author", scopes: ["doc:read"] }),
    ).toThrow();
    expect(() => agentTokenMint.input.parse({ agent_id: BOT, tier: "custom" })).toThrow();
  });

  it("input contract: literal admin, duplicates, and empty lists are refused for EVERY caller", () => {
    expect(() =>
      agentTokenMint.input.parse({ agent_id: BOT, tier: "custom", scopes: ["admin"] }),
    ).toThrow();
    expect(() =>
      agentTokenMint.input.parse({
        agent_id: BOT,
        tier: "custom",
        scopes: ["doc:read", "doc:read"],
      }),
    ).toThrow();
    expect(() =>
      agentTokenMint.input.parse({ agent_id: BOT, tier: "custom", scopes: [] }),
    ).toThrow();
  });
});

describe("agent.token_mint — non-amplification (caller-relative half)", () => {
  it("an agent minter cannot exceed its own scopes (custom list)", async () => {
    const err = await agentTokenMint
      .handler(
        buildCtx(agentPrincipal({ scopes: ["workspace:read", "agent:create"] })),
        agentTokenMint.input.parse({ agent_id: BOT, tier: "custom", scopes: ["doc:write"] }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("scope_amplification");
    }
    expect(await db.selectFrom("agent_tokens").selectAll().execute()).toHaveLength(0);
  });

  it("a named tier counts via its EXPANSION — a narrow agent cannot mint tier author", async () => {
    const err = await agentTokenMint
      .handler(
        buildCtx(agentPrincipal({ scopes: ["workspace:read", "agent:create"] })),
        agentTokenMint.input.parse({ agent_id: BOT, tier: "author" }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("scope_amplification");
    }
  });

  it("an agent minter minting ⊆ its own scopes succeeds; created_by = its human anchor", async () => {
    const out = await agentTokenMint.handler(
      buildCtx(agentPrincipal({ scopes: ["workspace:read", "doc:read", "agent:create"] })),
      agentTokenMint.input.parse({ agent_id: BOT, tier: "custom", scopes: ["doc:read"] }),
    );
    expect(out.scopes).toEqual(["doc:read"]);
    expect(out.created_by).toBe(BOT_OWNER);
  });

  it("a delegated minter attributes to the DELEGATOR", async () => {
    const out = await agentTokenMint.handler(
      buildCtx(
        agentPrincipal({ scopes: ["workspace:read", "agent:create"], acting_as: DELEGATOR }),
      ),
      agentTokenMint.input.parse({ agent_id: BOT, tier: "custom", scopes: ["workspace:read"] }),
    );
    expect(out.created_by).toBe(DELEGATOR);
  });

  it("human minters skip the rung — any mintable tier goes", async () => {
    const out = await agentTokenMint.handler(
      buildCtx(user(ADMIN)),
      agentTokenMint.input.parse({ agent_id: BOT, tier: "editor" }),
    );
    expect(out.scopes).toEqual([...AGENT_SCOPE_TIERS.editor]);
  });
});

describe("agent.token_mint — liveness + expiry", () => {
  it("missing agent → 404", async () => {
    await expect(
      agentTokenMint.handler(
        buildCtx(user(ADMIN)),
        agentTokenMint.input.parse({ agent_id: MISSING_BOT, tier: "author" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("revoked agent → agent_revoked (the dead cannot be re-credentialed)", async () => {
    const err = await agentTokenMint
      .handler(
        buildCtx(user(ADMIN)),
        agentTokenMint.input.parse({ agent_id: BOT_REVOKED, tier: "author" }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("agent_revoked");
    }
  });

  it("expires_at at-or-before the handler clock → expires_in_past; future passes; null passes", async () => {
    const err = await agentTokenMint
      .handler(
        buildCtx(user(ADMIN), 5000),
        agentTokenMint.input.parse({ agent_id: BOT, tier: "author", expires_at: 5000 }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("expires_in_past");
    }

    const future = await agentTokenMint.handler(
      buildCtx(user(ADMIN), 5000),
      agentTokenMint.input.parse({ agent_id: BOT, tier: "author", expires_at: 6000 }),
    );
    expect(future.expires_at).toBe(6000);

    const evergreen = await agentTokenMint.handler(
      buildCtx(user(ADMIN), 5000),
      agentTokenMint.input.parse({ agent_id: BOT, tier: "read-only" }),
    );
    expect(evergreen.expires_at).toBeNull();
  });
});

describe("agent.token_mint — registry facts", () => {
  it("is METADATA_ONLY (dispatcher-tx lane; invariant 7)", () => {
    expect(isMetadataOnlyCapability(agentTokenMint.id)).toBe(true);
  });
});
