/**
 * Agent bearer-token end-to-end integration test (ADR 0044 Decision 4).
 *
 * The unit tests pin the seams in isolation: `db/resolve-agent-token`
 * (the SQL liveness conjuncts) and `middleware/agent-bearer` (routing +
 * assembly, with a FAKE resolver). This file proves the seams compose
 * against a REAL stack — Better Auth + the capability dispatcher + the
 * `createResolveAgentToken` db lookup, all on one in-memory SQLite —
 * so the same hash function mints AND resolves, and the wiring through
 * `createApiApp({ resolveAgentToken })` actually reaches a route:
 *
 *   1. An owner signs up (→ workspace + owner membership) and creates an
 *      agent, then mints a `read-only` token (show-once secret).
 *   2. Presenting that secret as `Authorization: Bearer ez_agent_…` —
 *      with NO cookie — resolves `/infra/whoami` to the AGENT principal
 *      (api-key, owner = the creator, the read-only scope set).
 *   3. A well-formed-but-unminted token 401s.
 *   4. Revoking the token (then the agent) terminally stops resolution —
 *      the liveness conjuncts, proven through the real revoke routes.
 *
 * `/infra/whoami` is the probe precisely because it gates on
 * authentication alone (no permission scope), so the assertions isolate
 * "who did the bearer arm resolve" from any capability-gate behaviour.
 */

import { createAuth, runAuthMigrations } from "@editorzero/auth";
import {
  agentCreate,
  agentRevoke,
  agentTokenMint,
  agentTokenRevoke,
  createRegistry,
  registerCapability,
} from "@editorzero/capabilities";
import {
  createLoadRoles,
  createResolveAgentToken,
  createSqliteDriver,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiApp } from "../app";
import { createApiDispatcher } from "./createApiDispatcher";

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

const PASSWORD = "correct-horse-battery-staple";

async function buildStack() {
  const auth = createAuth({
    driver,
    baseURL: "http://localhost:3000",
    secret: "test-secret-do-not-use-in-production-at-all",
    trustedOrigins: ["http://localhost:3000"],
    registrationMode: "open",
  });
  await runAuthMigrations(auth);
  // Only the agent-lifecycle capabilities the flow exercises — create +
  // mint to issue a credential, revoke + token_revoke to prove liveness.
  const registry = createRegistry([
    registerCapability(agentCreate),
    registerCapability(agentTokenMint),
    registerCapability(agentRevoke),
    registerCapability(agentTokenRevoke),
  ]);
  // Metadata-only mutators — no HocuspocusSync needed (no content write path).
  const dispatcher = createApiDispatcher({ driver, registry });
  const loadRoles = createLoadRoles(driver);
  const resolveAgentToken = createResolveAgentToken(driver);
  const trunk = createApiApp({ auth, loadRoles, dispatcher, resolveAgentToken });
  return { trunk };
}

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie
    .split(/,(?=\s*[^ ;]+=)/u)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}

type Trunk = Awaited<ReturnType<typeof buildStack>>["trunk"];

async function signUpAndIn(trunk: Trunk, email: string): Promise<string> {
  const up = await trunk.request("/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, name: email.split("@")[0] }),
  });
  expect(up.status).toBe(200);
  const signedIn = await trunk.request("/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(signedIn.status).toBe(200);
  return sessionCookieFrom(signedIn);
}

async function createAgent(trunk: Trunk, cookie: string, name: string): Promise<string> {
  const res = await trunk.request("/agents/create", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { agent_id: string };
  return body.agent_id;
}

async function mintReadOnlyToken(
  trunk: Trunk,
  cookie: string,
  agentId: string,
): Promise<{ token: string; token_id: string }> {
  const res = await trunk.request(`/agents/token_mint/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ tier: "read-only" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; token_id: string };
  return body;
}

async function whoamiWithBearer(trunk: Trunk, token: string): Promise<Response> {
  return trunk.request("/infra/whoami", { headers: { authorization: `Bearer ${token}` } });
}

describe("agent bearer token — end-to-end", () => {
  it("mint → present Bearer → /infra/whoami resolves the AGENT principal", async () => {
    const { trunk } = await buildStack();
    const cookie = await signUpAndIn(trunk, "owner@example.com");

    // The owner's own identity, to assert the attribution ladder.
    const meRes = await trunk.request("/infra/whoami", { headers: { cookie } });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { kind: string; id: string };
    expect(me.kind).toBe("user");
    const ownerId = me.id;

    const agentId = await createAgent(trunk, cookie, "resolver-bot");
    const { token, token_id } = await mintReadOnlyToken(trunk, cookie, agentId);
    expect(token.startsWith("ez_agent_")).toBe(true);

    // Bearer ONLY — no cookie. The principal must resolve through the
    // real db lookup + real hash to the agent, not the owner.
    const res = await whoamiWithBearer(trunk, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      id: string;
      owner_user_id: string | null;
      token_kind: string;
      token_id: string;
      scopes: string[];
    };
    expect(body.kind).toBe("agent");
    expect(body.id).toBe(agentId);
    expect(body.owner_user_id).toBe(ownerId);
    expect(body.token_kind).toBe("api-key");
    expect(body.token_id).toBe(token_id);
    // The read-only tier expands to a read scope set.
    expect(body.scopes).toContain("doc:read");
  });

  it("401s a well-formed but unminted agent Bearer (no matching hash)", async () => {
    const { trunk } = await buildStack();
    const res = await whoamiWithBearer(
      trunk,
      "ez_agent_0000000000000000000000000000000000000000000",
    );
    expect(res.status).toBe(401);
  });

  it("stops resolving once the token is revoked (terminal, via the real route)", async () => {
    const { trunk } = await buildStack();
    const cookie = await signUpAndIn(trunk, "token-revoke@example.com");
    const agentId = await createAgent(trunk, cookie, "token-revoke-bot");
    const { token, token_id } = await mintReadOnlyToken(trunk, cookie, agentId);

    // Sanity — the freshly minted secret authenticates.
    expect((await whoamiWithBearer(trunk, token)).status).toBe(200);

    const revoke = await trunk.request("/agents/token_revoke", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ token_id }),
    });
    expect(revoke.status).toBe(200);

    // The same secret no longer authenticates — revocation is terminal.
    expect((await whoamiWithBearer(trunk, token)).status).toBe(401);
  });

  it("stops resolving once the OWNING AGENT is revoked (conjunct 3, real route)", async () => {
    const { trunk } = await buildStack();
    const cookie = await signUpAndIn(trunk, "agent-revoke@example.com");
    const agentId = await createAgent(trunk, cookie, "agent-revoke-bot");
    const { token } = await mintReadOnlyToken(trunk, cookie, agentId);

    expect((await whoamiWithBearer(trunk, token)).status).toBe(200);

    // `/agents/revoke/:agent_id` is param-only — no body.
    const revoke = await trunk.request(`/agents/revoke/${agentId}`, {
      method: "POST",
      headers: { cookie },
    });
    expect(revoke.status).toBe(200);

    // The live token now hangs off a revoked agent — the join drops it.
    expect((await whoamiWithBearer(trunk, token)).status).toBe(401);
  });
});
