import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  AGENT_LIST_QUERY_KEY,
  AGENT_TOKEN_NAMED_TIERS,
  agentListQueryOptions,
  agentQueryKey,
  agentQueryOptions,
  agentTokensQueryKey,
  agentTokensQueryOptions,
  createAgent,
  fetchAgent,
  fetchAgentList,
  fetchAgentTokens,
  isRevoked,
  lifecycleStatusLabel,
  lifecycleTagClass,
  mintAgentToken,
  revokeAgent,
  revokeAgentToken,
  tokenDisplayId,
  tokenExpiryLabel,
  tokenScopeSummary,
  updateAgent,
} from "./agents";

/**
 * Same fake-client pattern as `spaces.test.ts`: a REAL typed client with
 * an injected fetch returning one canned response — `res.json()` yields
 * the typed union with no `as` anywhere.
 */
function clientReturning(status: number, body: BodyInit | null): ApiClient {
  const fetchImpl: typeof fetch = async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
  return createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl });
}

function jsonClient(status: number, body: unknown): ApiClient {
  return clientReturning(status, JSON.stringify(body));
}

const WS = "018f0000-0000-7000-8000-0000000000aa";
const OWNER = "018f0000-0000-7000-8000-0000000000cc";
const AGENT_ID = "018f0000-0000-7000-8000-0000000000a1";

const AGENT_LIVE = {
  agent_id: AGENT_ID,
  workspace_id: WS,
  name: "Indexer",
  owner_user_id: OWNER,
  created_by: OWNER,
  created_at: 1,
  updated_at: 2,
  revoked_at: null,
};

const AGENT_REVOKED = {
  ...AGENT_LIVE,
  agent_id: "018f0000-0000-7000-8000-0000000000a2",
  name: "Retired",
  revoked_at: 99,
};

const TWO_AGENTS = { agents: [AGENT_LIVE, AGENT_REVOKED] };

const TOKEN_LIVE = {
  token_id: "018f0000-0000-7000-8000-0000000000b1",
  workspace_id: WS,
  agent_id: AGENT_ID,
  token_prefix: "ez_agent_abc",
  last4: "wxyz",
  scopes: ["doc:read", "comment:read"],
  tier: "read-only",
  created_by: OWNER,
  created_at: 5,
  expires_at: null,
  revoked_at: null,
};

const TWO_TOKENS = {
  tokens: [
    TOKEN_LIVE,
    {
      ...TOKEN_LIVE,
      token_id: "018f0000-0000-7000-8000-0000000000b2",
      scopes: ["doc:read"],
      expires_at: 1000,
      revoked_at: 42,
    },
  ],
};

describe("fetchAgentList", () => {
  it("resolves the agents payload on 200", async () => {
    const result = await fetchAgentList(jsonClient(200, TWO_AGENTS));
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]?.name).toBe("Indexer");
  });

  it("throws ApiError with the typed envelope code on a 403", async () => {
    await expect(
      fetchAgentList(jsonClient(403, { error: "permission_denied" })),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });

  it("falls back to request_failed for a non-JSON 5xx", async () => {
    await expect(fetchAgentList(clientReturning(500, "<html>oops</html>"))).rejects.toMatchObject({
      status: 500,
      code: "request_failed",
    });
  });
});

describe("agentListQueryOptions", () => {
  it("binds the stable query key to fetchAgentList against the given client", async () => {
    const options = agentListQueryOptions(jsonClient(200, TWO_AGENTS));
    expect(options.queryKey).toEqual(AGENT_LIST_QUERY_KEY);
    const result = await new QueryClient().fetchQuery(options);
    expect(result.agents.map((a) => a.name)).toEqual(["Indexer", "Retired"]);
  });
});

describe("fetchAgent", () => {
  it("resolves the bare row on 200 (no wrapper)", async () => {
    const agent = await fetchAgent(AGENT_ID, jsonClient(200, AGENT_LIVE));
    expect(agent.name).toBe("Indexer");
    expect(agent.revoked_at).toBeNull();
  });

  it("throws ApiError with the typed envelope code on a 404 (invisible agent)", async () => {
    await expect(
      fetchAgent(AGENT_ID, jsonClient(404, { error: "not_found" })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("throws an ApiError instance on a 403", async () => {
    await expect(
      fetchAgent(AGENT_ID, jsonClient(403, { error: "permission_denied" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("agentQueryOptions", () => {
  it("keys the cache per agent id and binds fetchAgent against the given client", async () => {
    const options = agentQueryOptions(AGENT_ID, jsonClient(200, AGENT_LIVE));
    expect(options.queryKey).toEqual(agentQueryKey(AGENT_ID));
    expect(agentQueryKey("a")).not.toEqual(agentQueryKey("b"));
    const agent = await new QueryClient().fetchQuery(options);
    expect(agent.name).toBe("Indexer");
  });
});

describe("createAgent", () => {
  it("resolves the full row echo on 200 (navigation reads agent_id)", async () => {
    const created = await createAgent("Indexer", jsonClient(200, AGENT_LIVE));
    expect(created.agent_id).toBe(AGENT_ID);
  });

  it("throws an ApiError instance on a 400", async () => {
    await expect(
      createAgent("", jsonClient(400, { error: "validation_failed" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("updateAgent", () => {
  it("resolves the renamed row on 200", async () => {
    const updated = await updateAgent(AGENT_ID, "Reindexer", jsonClient(200, AGENT_LIVE));
    expect(updated.agent_id).toBe(AGENT_ID);
  });

  it("throws ApiError on a 404 (gone since the form opened)", async () => {
    await expect(
      updateAgent(AGENT_ID, "Reindexer", jsonClient(404, { error: "not_found" })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("revokeAgent", () => {
  it("resolves the revocation echo on 200", async () => {
    const revoked = await revokeAgent(
      AGENT_ID,
      jsonClient(200, { agent_id: AGENT_ID, revoked_at: 123 }),
    );
    expect(revoked.revoked_at).toBe(123);
  });

  it("throws an ApiError instance on a 403", async () => {
    await expect(
      revokeAgent(AGENT_ID, jsonClient(403, { error: "permission_denied" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("fetchAgentTokens", () => {
  it("resolves the tokens payload on 200", async () => {
    const result = await fetchAgentTokens(AGENT_ID, jsonClient(200, TWO_TOKENS));
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[0]?.tier).toBe("read-only");
  });

  it("throws ApiError on a 404", async () => {
    await expect(
      fetchAgentTokens(AGENT_ID, jsonClient(404, { error: "not_found" })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("agentTokensQueryOptions", () => {
  it("keys the cache per agent id and binds fetchAgentTokens against the given client", async () => {
    const options = agentTokensQueryOptions(AGENT_ID, jsonClient(200, TWO_TOKENS));
    expect(options.queryKey).toEqual(agentTokensQueryKey(AGENT_ID));
    expect(agentTokensQueryKey("a")).not.toEqual(agentTokensQueryKey("b"));
    const result = await new QueryClient().fetchQuery(options);
    expect(result.tokens).toHaveLength(2);
  });
});

describe("mintAgentToken", () => {
  it("resolves the row PLUS the show-once plaintext token on 200", async () => {
    const minted = await mintAgentToken(
      AGENT_ID,
      "read-only",
      jsonClient(200, { ...TOKEN_LIVE, token: `ez_agent_${"a".repeat(43)}` }),
    );
    expect(minted.token).toMatch(/^ez_agent_/);
    expect(minted.tier).toBe("read-only");
  });

  it("throws an ApiError instance on a 403 (no-amplification refusal)", async () => {
    await expect(
      mintAgentToken(AGENT_ID, "admin", jsonClient(403, { error: "permission_denied" })),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("revokeAgentToken", () => {
  it("resolves the revocation echo on 200", async () => {
    const revoked = await revokeAgentToken(
      TOKEN_LIVE.token_id,
      jsonClient(200, { token_id: TOKEN_LIVE.token_id, revoked_at: 7 }),
    );
    expect(revoked.revoked_at).toBe(7);
  });

  it("throws ApiError on a 404 (already gone)", async () => {
    await expect(
      revokeAgentToken(TOKEN_LIVE.token_id, jsonClient(404, { error: "not_found" })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("lifecycle display (shared by agents + tokens)", () => {
  it("isRevoked reads the terminal revoked_at timestamp", () => {
    expect(isRevoked({ revoked_at: null })).toBe(false);
    expect(isRevoked({ revoked_at: 99 })).toBe(true);
  });

  it("lifecycleStatusLabel names the two states", () => {
    expect(lifecycleStatusLabel(false)).toBe("Active");
    expect(lifecycleStatusLabel(true)).toBe("Revoked");
  });

  it("lifecycleTagClass picks the audit chip variants (st-pub live, st-warn revoked)", () => {
    expect(lifecycleTagClass(false)).toBe("status-tag st-pub");
    expect(lifecycleTagClass(true)).toBe("status-tag st-warn");
  });
});

describe("token display helpers", () => {
  it("tokenDisplayId joins the prefix and last four with an ellipsis", () => {
    expect(tokenDisplayId({ token_prefix: "ez_agent_abc", last4: "wxyz" })).toBe(
      "ez_agent_abc…wxyz",
    );
  });

  it("tokenScopeSummary pluralizes the scope count", () => {
    expect(tokenScopeSummary({ scopes: [] })).toBe("0 scopes");
    expect(tokenScopeSummary({ scopes: ["doc:read"] })).toBe("1 scope");
    expect(tokenScopeSummary({ scopes: ["doc:read", "comment:read"] })).toBe("2 scopes");
  });

  it("tokenExpiryLabel renders 'never' for a null expiry, else the formatted instant", () => {
    const fmt = (ms: number) => `FMT:${ms}`;
    expect(tokenExpiryLabel({ expires_at: null }, fmt)).toBe("never");
    expect(tokenExpiryLabel({ expires_at: 1000 }, fmt)).toBe("FMT:1000");
  });
});

describe("AGENT_TOKEN_NAMED_TIERS (the vocabulary pin)", () => {
  it("carries the four named tiers (AGENT_TOKEN_TIERS minus custom), in order", () => {
    expect(AGENT_TOKEN_NAMED_TIERS).toEqual(["read-only", "author", "editor", "admin"]);
  });
});
