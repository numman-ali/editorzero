/**
 * `agent.update` unit suite — real in-memory SQLite.
 *
 * Pins rename semantics: stored-timestamp honesty on the idempotent
 * same-name echo (zero writes — echoing `now` would claim a write that
 * never happened), the terminal-revocation refusal, live-name
 * collision with revoked-name reuse, and the patch-shaped audit
 * effect.
 */

import {
  AGENT_TOKENS_DDL,
  AGENTS_DDL,
  createSqliteDriver,
  type SqliteDriver,
  type TenantScopedDb,
} from "@editorzero/db";
import { ConflictError, NotFoundError, ValidationError } from "@editorzero/errors";
import { AgentId, UserId, WorkspaceId } from "@editorzero/ids";
import { noopLogger, noopTracer } from "@editorzero/observability";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { isMetadataOnlyCapability, type Role } from "@editorzero/scopes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapabilityContext } from "../kernel";
import { agentUpdate } from "./update";

// ── Fixtures ─────────────────────────────────────────────────────────────

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const ADMIN = UserId("018f0000-0000-7000-8000-0000000000a2");
const BOT = AgentId("018f0000-0000-7000-8000-0000000000b1");
const BOT_REVOKED = AgentId("018f0000-0000-7000-8000-0000000000b2");
const MISSING_BOT = AgentId("018f0000-0000-7000-8000-0000000000b9");

let driver: SqliteDriver;
let db: TenantScopedDb;

beforeEach(async () => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(AGENTS_DDL);
  driver.exec(AGENT_TOKENS_DDL);
  db = driver.scoped(WORKSPACE_A);
  await seedAgent(BOT, "alpha", null);
  await seedAgent(BOT_REVOKED, "graveyard", 2000);
});

afterEach(async () => {
  await driver.close();
});

async function seedAgent(id: AgentId, name: string, revoked_at: number | null) {
  await db
    .insertInto("agents")
    .values({
      id,
      workspace_id: WORKSPACE_A,
      name,
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

function buildCtx(principal: Principal, now = 5000): CapabilityContext {
  return {
    principal,
    tenant: { workspace_id: WORKSPACE_A },
    db,
    transact: async () => {
      throw new Error("metadata-only capability must not call ctx.transact");
    },
    outbox: () => {
      /* agent.update enqueues nothing */
    },
    logger: noopLogger,
    tracer: noopTracer,
    now: () => now,
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────

describe("agent.update — rename", () => {
  it("renames: row + echo updated, updated_at = now, created_at preserved", async () => {
    const out = await agentUpdate.handler(
      buildCtx(user(ADMIN), 6000),
      agentUpdate.input.parse({ agent_id: BOT, name: "alpha-v2" }),
    );
    expect(out.name).toBe("alpha-v2");
    expect(out.created_at).toBe(1000);
    expect(out.updated_at).toBe(6000);

    const row = await db.selectFrom("agents").selectAll().where("id", "=", BOT).executeTakeFirst();
    expect(row?.name).toBe("alpha-v2");
    expect(row?.updated_at).toBe(6000);
  });

  it("idempotent same-name: ZERO writes — stored timestamps echoed verbatim", async () => {
    const out = await agentUpdate.handler(
      buildCtx(user(ADMIN), 6000),
      agentUpdate.input.parse({ agent_id: BOT, name: "alpha" }),
    );
    expect(out.name).toBe("alpha");
    // The stored clock, NOT the handler clock — no write happened.
    expect(out.updated_at).toBe(1000);

    const row = await db.selectFrom("agents").selectAll().where("id", "=", BOT).executeTakeFirst();
    expect(row?.updated_at).toBe(1000);
  });

  it("missing agent → 404", async () => {
    await expect(
      agentUpdate.handler(
        buildCtx(user(ADMIN)),
        agentUpdate.input.parse({ agent_id: MISSING_BOT, name: "ghost" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("revoked agent → agent_revoked refusal (terminal; the record stays as it died)", async () => {
    const err = await agentUpdate
      .handler(
        buildCtx(user(ADMIN)),
        agentUpdate.input.parse({ agent_id: BOT_REVOKED, name: "necro" }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    if (err instanceof ValidationError) {
      expect(JSON.stringify(err.issues)).toContain("agent_revoked");
    }
    const row = await db
      .selectFrom("agents")
      .selectAll()
      .where("id", "=", BOT_REVOKED)
      .executeTakeFirst();
    expect(row?.name).toBe("graveyard");
  });
});

describe("agent.update — live-name uniqueness", () => {
  it("renaming onto another LIVE agent's name → ConflictError", async () => {
    await seedAgent(AgentId("018f0000-0000-7000-8000-0000000000b3"), "taken", null);
    await expect(
      agentUpdate.handler(
        buildCtx(user(ADMIN)),
        agentUpdate.input.parse({ agent_id: BOT, name: "taken" }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("a revoked agent's name is FREE — renaming onto it succeeds", async () => {
    const out = await agentUpdate.handler(
      buildCtx(user(ADMIN)),
      agentUpdate.input.parse({ agent_id: BOT, name: "graveyard" }),
    );
    expect(out.name).toBe("graveyard");
  });
});

describe("agent.update — projections + registry facts", () => {
  it("audit effect is patch-shaped: {agent_id, patch: {name}}", async () => {
    const input = agentUpdate.input.parse({ agent_id: BOT, name: "alpha-v3" });
    const out = await agentUpdate.handler(buildCtx(user(ADMIN)), input);
    expect(agentUpdate.audit.effectOnAllow(input, out)).toEqual({
      kind: "agent.update",
      agent_id: BOT,
      patch: { name: "alpha-v3" },
    });
  });

  it("is METADATA_ONLY (dispatcher-tx lane; invariant 7)", () => {
    expect(isMetadataOnlyCapability(agentUpdate.id)).toBe(true);
  });
});
