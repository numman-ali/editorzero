/**
 * `agent.list` + `agent.get` + `agent.create` + `agent.update` +
 * `agent.revoke` + `agent.token_list` + `agent.token_mint` +
 * `agent.token_revoke` data-layer — the eight Agents-screen capability
 * cells (invariant 4 + invariant 8, ADR 0044 Decision 7). Agents are
 * NAME-addressed first-class principals, so the screen needs no user
 * picker — it is not blocked on the identity-resolution cluster.
 *
 * Same split as `spaces.ts`/`docs.ts`: the `fetch*`/mutate functions are
 * the testable plain layer (fake-client unit tests in `agents.test.ts`);
 * the `*QueryOptions` are the react-query bindings the route loaders
 * (`ensureQueryData`) and components (`useSuspenseQuery`) share. Every
 * type is DERIVED from the materialized `ApiClient` (SSOT — the wire
 * schemas live server-side; the `hc` client type is the browser-safe
 * projection). The list capability returns agents in its own order
 * (admin-tier sees all; others see agents anchored to them) and revoked
 * agents stay VISIBLE (terminal-but-visible, Decision 2) — the screen
 * renders that wire truth and adds none of its own.
 */
import { type ApiClient, ApiError } from "@editorzero/api-client";
import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import { readErrorCode } from "./wire-error";

// ── agent.list ─────────────────────────────────────────────────────────────

type AgentListResponse = Awaited<ReturnType<ApiClient["agents"]["list"]["$get"]>>;
// The handler returns typed error envelopes alongside the 200, so `json()`
// is a union — extract the success arm by its literal status before
// deriving the body (the spaces.ts pattern).
type AgentListSuccess = Extract<AgentListResponse, { status: 200 }>;
export type AgentList = Awaited<ReturnType<AgentListSuccess["json"]>>;
export type AgentSummary = AgentList["agents"][number];

export const AGENT_LIST_QUERY_KEY = ["agent.list"] as const;

/** Fetch the caller-visible agents; the error arm surfaces a typed `ApiError`. */
export async function fetchAgentList(client: ApiClient = apiClient): Promise<AgentList> {
  const res = await client.agents.list.$get();
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function agentListQueryOptions(client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: AGENT_LIST_QUERY_KEY,
    queryFn: () => fetchAgentList(client),
  });
}

// ── agent.get ──────────────────────────────────────────────────────────────

type AgentGetResponse = Awaited<ReturnType<ApiClient["agents"]["get"][":agent_id"]["$get"]>>;
type AgentGetSuccess = Extract<AgentGetResponse, { status: 200 }>;
/** The full agent row — `agent.get` returns it verbatim (no wrapper). */
export type AgentDetail = Awaited<ReturnType<AgentGetSuccess["json"]>>;

export function agentQueryKey(agentId: string) {
  return ["agent.get", agentId] as const;
}

/**
 * Fetch one agent. Visibility is the same admin-OR-anchored rule as the
 * list; an unknown or out-of-reach agent 404s, which the route loader
 * surfaces through the error boundary.
 */
export async function fetchAgent(
  agentId: string,
  client: ApiClient = apiClient,
): Promise<AgentDetail> {
  const res = await client.agents.get[":agent_id"].$get({ param: { agent_id: agentId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function agentQueryOptions(agentId: string, client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: agentQueryKey(agentId),
    queryFn: () => fetchAgent(agentId, client),
  });
}

// ── agent.create ───────────────────────────────────────────────────────────

type AgentCreateResponse = Awaited<ReturnType<ApiClient["agents"]["create"]["$post"]>>;
type AgentCreateSuccess = Extract<AgentCreateResponse, { status: 200 }>;
export type AgentCreated = Awaited<ReturnType<AgentCreateSuccess["json"]>>;

/**
 * Create an agent. The only wire field is the display name (1–120 chars,
 * trimmed); authority always grounds in the creating human (Decision 2).
 * Names are NOT unique — reuse, including after a revoke, is allowed — so
 * there is no duplicate-name arm; any failure is a generic retry. Returns
 * the full row echo; callers navigate on `agent_id`.
 */
export async function createAgent(
  name: string,
  client: ApiClient = apiClient,
): Promise<AgentCreated> {
  const res = await client.agents.create.$post({ json: { name } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

// ── agent.update ───────────────────────────────────────────────────────────

type AgentUpdateResponse = Awaited<ReturnType<ApiClient["agents"]["update"][":agent_id"]["$post"]>>;
type AgentUpdateSuccess = Extract<AgentUpdateResponse, { status: 200 }>;
export type AgentUpdated = Awaited<ReturnType<AgentUpdateSuccess["json"]>>;

/**
 * Rename an agent (the only mutable field — an agent has no slug, type,
 * or baseline the way a space does). The form sends the new name only
 * when it actually changed (the rename-doc no-op precedent); this layer
 * just carries it.
 */
export async function updateAgent(
  agentId: string,
  name: string,
  client: ApiClient = apiClient,
): Promise<AgentUpdated> {
  const res = await client.agents.update[":agent_id"].$post({
    param: { agent_id: agentId },
    json: { name },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

// ── agent.revoke ───────────────────────────────────────────────────────────

type AgentRevokeResponse = Awaited<ReturnType<ApiClient["agents"]["revoke"][":agent_id"]["$post"]>>;
type AgentRevokeSuccess = Extract<AgentRevokeResponse, { status: 200 }>;
export type AgentRevoked = Awaited<ReturnType<AgentRevokeSuccess["json"]>>;

/**
 * Revoke an agent (invariant 8 — agents are revocable). Terminal: it
 * cascades to the agent's tokens (no bearer survives a revoked agent) and
 * never resets. The row STAYS visible afterwards with `revoked_at` set
 * (terminal-but-visible), so callers re-render the revoked state rather
 * than expecting the agent to vanish.
 */
export async function revokeAgent(
  agentId: string,
  client: ApiClient = apiClient,
): Promise<AgentRevoked> {
  const res = await client.agents.revoke[":agent_id"].$post({ param: { agent_id: agentId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

// ── agent.token_list ─────────────────────────────────────────────────────────

type AgentTokenListResponse = Awaited<
  ReturnType<ApiClient["agents"]["token_list"][":agent_id"]["$get"]>
>;
type AgentTokenListSuccess = Extract<AgentTokenListResponse, { status: 200 }>;
export type AgentTokenList = Awaited<ReturnType<AgentTokenListSuccess["json"]>>;
export type AgentTokenSummary = AgentTokenList["tokens"][number];

export function agentTokensQueryKey(agentId: string) {
  return ["agent.token_list", agentId] as const;
}

/**
 * List an agent's bearer tokens. The rows carry the display identity
 * (`token_prefix` + `last4`) and the recorded `tier` / expanded `scopes`,
 * never anything verifiable — the secret existed only in the mint echo.
 */
export async function fetchAgentTokens(
  agentId: string,
  client: ApiClient = apiClient,
): Promise<AgentTokenList> {
  const res = await client.agents.token_list[":agent_id"].$get({ param: { agent_id: agentId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

export function agentTokensQueryOptions(agentId: string, client: ApiClient = apiClient) {
  return queryOptions({
    queryKey: agentTokensQueryKey(agentId),
    queryFn: () => fetchAgentTokens(agentId, client),
  });
}

// ── agent.token_mint ─────────────────────────────────────────────────────────

type AgentTokenMintResponse = Awaited<
  ReturnType<ApiClient["agents"]["token_mint"][":agent_id"]["$post"]>
>;
type AgentTokenMintSuccess = Extract<AgentTokenMintResponse, { status: 200 }>;
/** The minted token row PLUS the show-once plaintext `token` (never stored). */
export type AgentTokenMinted = Awaited<ReturnType<AgentTokenMintSuccess["json"]>>;

/**
 * The named mint tiers the Web UI offers — `AGENT_TOKEN_TIERS` minus
 * `custom`. A named tier expands handler-side to its scope set, so the
 * mint needs nothing but the tier name; `custom` (an explicit scopes
 * list) is the one mode the bare cell omits — the same "advanced field
 * trails to a later increment" call `space.create` made for
 * `baseline_access`. Custom minting stays reachable on API/CLI/MCP.
 *
 * Mirrored as a local `as const` (not imported from `@editorzero/scopes`
 * — the SPA derives types from the client, never the server packages);
 * the unit pin below + the e2e `selectOption` fail loudly if the server
 * tier vocabulary moves out from under it.
 */
export const AGENT_TOKEN_NAMED_TIERS = ["read-only", "author", "editor", "admin"] as const;
export type AgentNamedTier = (typeof AGENT_TOKEN_NAMED_TIERS)[number];

/**
 * Mint a bearer token for an agent at a named tier. Returns the row +
 * the show-once `token`; the caller MUST surface the plaintext exactly
 * once and then drop it (it is never recoverable). Owners may mint any
 * tier; an agent caller is held to ⊆ its own scopes (handler-side
 * non-amplification) — out of reach for today's single owner principal.
 */
export async function mintAgentToken(
  agentId: string,
  tier: AgentNamedTier,
  client: ApiClient = apiClient,
): Promise<AgentTokenMinted> {
  // Named tier ⇒ the body carries the tier alone; `scopes` MUST be absent
  // (the handler refuses a named tier + explicit scopes as ambiguous
  // intent), and `expires_at` rides its schema default (`null` — no
  // expiry). The bare cell mints non-expiring tokens; an expiry is set
  // via API/CLI/MCP.
  const res = await client.agents.token_mint[":agent_id"].$post({
    param: { agent_id: agentId },
    json: { tier },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

// ── agent.token_revoke ───────────────────────────────────────────────────────

type AgentTokenRevokeResponse = Awaited<ReturnType<ApiClient["agents"]["token_revoke"]["$post"]>>;
type AgentTokenRevokeSuccess = Extract<AgentTokenRevokeResponse, { status: 200 }>;
export type AgentTokenRevoked = Awaited<ReturnType<AgentTokenRevokeSuccess["json"]>>;

/**
 * Revoke a single bearer token (the agent itself stays live — this is the
 * narrow "rotate one credential" verb, distinct from `agent.revoke`).
 * Terminal; the row stays visible with `revoked_at` set.
 */
export async function revokeAgentToken(
  tokenId: string,
  client: ApiClient = apiClient,
): Promise<AgentTokenRevoked> {
  const res = await client.agents.token_revoke.$post({ json: { token_id: tokenId } });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorCode(res));
  }
  return res.json();
}

// ── lifecycle display (shared by agents + tokens) ────────────────────────────

/**
 * Both agents and tokens carry the same terminal `revoked_at` shape, so
 * one lifecycle vocabulary serves both: `null` ⇒ live, a timestamp ⇒
 * revoked (never resets). Kept here (unit-pinned) so the chips can't
 * drift between the agent header, the roster, and the token table.
 */
export function isRevoked(row: { revoked_at: number | null }): boolean {
  return row.revoked_at !== null;
}

export function lifecycleStatusLabel(revoked: boolean): "Active" | "Revoked" {
  return revoked ? "Revoked" : "Active";
}

/** `st-pub` (live) / `st-warn` (revoked) — the audit-chip variant idiom. */
export function lifecycleTagClass(revoked: boolean): string {
  return revoked ? "status-tag st-warn" : "status-tag st-pub";
}

/** The token's display identity: the non-verifiable prefix + last four. */
export function tokenDisplayId(token: Pick<AgentTokenSummary, "token_prefix" | "last4">): string {
  return `${token.token_prefix}…${token.last4}`;
}

/** Compact scope-count summary for the token table (the full list is long). */
export function tokenScopeSummary(token: Pick<AgentTokenSummary, "scopes">): string {
  const n = token.scopes.length;
  return `${n} scope${n === 1 ? "" : "s"}`;
}

/** The token's expiry cell: a formatted instant, or the literal "never". */
export function tokenExpiryLabel(
  token: Pick<AgentTokenSummary, "expires_at">,
  format: (epochMs: number) => string,
): string {
  return token.expires_at === null ? "never" : format(token.expires_at);
}
