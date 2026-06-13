/**
 * `createResolveAgentToken` — bearer-token lookup unit test (ADR 0044
 * Decision 4).
 *
 * Boots a real in-memory SQLite driver with the full DDL so the helper
 * runs against the production schema (composite FK, unique token-hash
 * index, the `agents` ⋈ `workspace_members` join). Exercises the
 * contract: a row is returned ONLY when all four liveness conjuncts hold,
 * and `null` (→ the composition's 401) the instant any one fails.
 *
 *   (1) token-hash match           — unknown hash → null
 *   (2a) token not revoked         — revoked_at set → null
 *   (2b) token not expired         — expires_at ≤ now → null; future / NULL → ok
 *   (3) owning agent live          — agent revoked_at set → null
 *   (4) owner a live member        — membership deleted / missing → null
 *
 * Plus: branded ids survive the aliased select, `scopes` comes back as
 * the RAW stored JSON string (the composition owns the parse), and the
 * expiry boundary is strict (`expires_at === now` counts as expired).
 */

import { AgentId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteDriver, type SqliteDriver } from "./drivers/sqlite";
import { SQLITE_FULL_DDL } from "./index";
import { createResolveAgentToken } from "./resolve-agent-token";

const WORKSPACE = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const OTHER_WORKSPACE = WorkspaceId("018f0000-0000-7000-8000-000000000002");
const OWNER = UserId("018f0000-0000-7000-8000-0000000000a1");
const AGENT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const TOKEN = TokenId("018f0000-0000-7000-8000-0000000000c1");

const HASH = "sha256-of-a-live-token";
const SCOPES_JSON = JSON.stringify(["doc:read", "doc:write"]);
const NOW = 1_000_000;

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

async function seedOwnerMember(deleted_at: number | null = null): Promise<void> {
  await driver
    .system()
    .insertInto("workspace_members")
    .values({
      workspace_id: WORKSPACE,
      user_id: OWNER,
      role: "member",
      created_at: 1,
      updated_at: 1,
      deleted_at,
    })
    .execute();
}

async function seedAgent(revoked_at: number | null = null): Promise<void> {
  await driver
    .system()
    .insertInto("agents")
    .values({
      id: AGENT,
      workspace_id: WORKSPACE,
      name: "resolver-bot",
      owner_user_id: OWNER,
      created_by: OWNER,
      created_at: 1,
      updated_at: 1,
      revoked_at,
    })
    .execute();
}

async function seedToken(
  overrides: { expires_at?: number | null; revoked_at?: number | null } = {},
): Promise<void> {
  await driver
    .system()
    .insertInto("agent_tokens")
    .values({
      id: TOKEN,
      workspace_id: WORKSPACE,
      agent_id: AGENT,
      token_hash: HASH,
      token_prefix: "ez_agent_abc",
      last4: "wxyz",
      scopes: SCOPES_JSON,
      tier: "custom",
      created_by: OWNER,
      created_at: 1,
      expires_at: overrides.expires_at ?? null,
      revoked_at: overrides.revoked_at ?? null,
    })
    .execute();
}

/** All four conjuncts green — the canonical live chain. */
async function seedLiveChain(
  token: { expires_at?: number | null; revoked_at?: number | null } = {},
): Promise<void> {
  await seedOwnerMember();
  await seedAgent();
  await seedToken(token);
}

describe("createResolveAgentToken", () => {
  it("resolves a live token to branded row data with RAW scopes", async () => {
    await seedLiveChain();
    const resolve = createResolveAgentToken(driver, () => NOW);
    const resolution = await resolve(HASH);
    expect(resolution).toEqual({
      token_id: TOKEN,
      agent_id: AGENT,
      workspace_id: WORKSPACE,
      owner_user_id: OWNER,
      scopes: SCOPES_JSON,
    });
  });

  it("returns null for an unknown token hash (conjunct 1)", async () => {
    await seedLiveChain();
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve("sha256-of-some-other-token")).toBeNull();
  });

  it("returns null when the token is revoked (conjunct 2a — terminal)", async () => {
    await seedLiveChain({ revoked_at: 500 });
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).toBeNull();
  });

  it("returns null when the token is expired (conjunct 2b)", async () => {
    await seedLiveChain({ expires_at: NOW - 1 });
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).toBeNull();
  });

  it("treats expires_at === now as expired (strict boundary)", async () => {
    await seedLiveChain({ expires_at: NOW });
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).toBeNull();
  });

  it("resolves a token whose expiry is in the future", async () => {
    await seedLiveChain({ expires_at: NOW + 1 });
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).not.toBeNull();
  });

  it("resolves a token with NULL expiry (never expires)", async () => {
    await seedLiveChain({ expires_at: null });
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).not.toBeNull();
  });

  it("returns null when the owning agent is revoked (conjunct 3)", async () => {
    await seedOwnerMember();
    await seedAgent(500); // agent revoked; token itself still live
    await seedToken();
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).toBeNull();
  });

  it("returns null when the owner's membership is soft-deleted (conjunct 4)", async () => {
    // Owner liveness gates auth: a removed member's agents stop resolving
    // with no cascade touching the agent/token rows.
    await seedOwnerMember(999);
    await seedAgent();
    await seedToken();
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).toBeNull();
  });

  it("returns null when the owner has no membership row at all", async () => {
    // No workspace_members seed — the owner was never (or no longer) a member.
    await seedAgent();
    await seedToken();
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).toBeNull();
  });

  it("returns null when the owner is a member of a DIFFERENT workspace only", async () => {
    // The join is owner + the agent's OWN workspace; a membership row in
    // another workspace must not satisfy it.
    await driver
      .system()
      .insertInto("workspace_members")
      .values({
        workspace_id: OTHER_WORKSPACE,
        user_id: OWNER,
        role: "owner",
        created_at: 1,
        updated_at: 1,
        deleted_at: null,
      })
      .execute();
    await seedAgent();
    await seedToken();
    const resolve = createResolveAgentToken(driver, () => NOW);
    expect(await resolve(HASH)).toBeNull();
  });

  it("defaults `now` to the wall clock when not injected", async () => {
    // A far-future expiry resolves under the real Date.now(); no clock
    // override. Pins the production default path (the factory's `now`
    // parameter), not just the injected-clock tests above.
    await seedLiveChain({ expires_at: Number.MAX_SAFE_INTEGER });
    const resolve = createResolveAgentToken(driver);
    expect(await resolve(HASH)).not.toBeNull();
  });
});
