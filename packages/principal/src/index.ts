/**
 * Principal model — the typed view of "who is making this request"
 * (architecture.md §3.3, §16.3, ADR 0016).
 *
 * `Principal` is a derived in-memory value constructed by the auth
 * middleware from Better Auth rows + `agents` / `users` joins. Never
 * stored as a row — always resolved per request. The capability
 * dispatcher sees only `Principal`; it does not know which credential
 * source produced it (session cookie, human PAT, agent API-key,
 * agent-auth token, MCP OAuth bearer).
 */

import type {
  AgentId,
  BlockId,
  DocId,
  SessionId,
  TokenId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import type { Role, Scope } from "@editorzero/scopes";

// Re-export Role so downstream packages don't need `@editorzero/scopes`
// just for the role union.
export type { Role };

/**
 * Agent-token provenance. Distinguishes long-lived revocable API keys
 * (`@better-auth/api-key`) from short-lived delegated tokens
 * (`@better-auth/agent-auth`, carries `act.sub` for `acting_as`).
 */
export type AgentTokenKind = "agent-auth" | "api-key";

/**
 * Human principal — the user is acting via session cookie or human PAT.
 * `token_id` is non-null when the credential was a bearer (PAT / OAuth);
 * it is null when the credential was a browser session cookie (the
 * session_id is authoritative then).
 */
export interface UserPrincipal {
  readonly kind: "user";
  readonly id: UserId;
  readonly workspace_id: WorkspaceId;
  readonly roles: readonly Role[];
  readonly session_id: SessionId | null;
  readonly token_id: TokenId | null;
}

/**
 * Agent principal. `owner_user_id` is set when the agent was created by a
 * specific human; null for workspace-owned automations. `acting_as` is
 * set only when `token_kind === "agent-auth"` and the token carries an
 * `act.sub` claim — the delegator whose effective permissions
 * `intersect(agent.scopes, delegator.permissions)` is applied against.
 */
export interface AgentPrincipal {
  readonly kind: "agent";
  readonly id: AgentId;
  readonly workspace_id: WorkspaceId;
  readonly owner_user_id: UserId | null;
  readonly scopes: readonly Scope[];
  readonly token_id: TokenId;
  readonly token_kind: AgentTokenKind;
  readonly acting_as?: UserId;
}

export type Principal = UserPrincipal | AgentPrincipal;

// ── Guards ─────────────────────────────────────────────────────────────────

export function isUser(p: Principal): p is UserPrincipal {
  return p.kind === "user";
}

export function isAgent(p: Principal): p is AgentPrincipal {
  return p.kind === "agent";
}

export function isDelegated(p: Principal): p is AgentPrincipal & { acting_as: UserId } {
  return p.kind === "agent" && p.acting_as !== undefined;
}

// ── TenantContext ──────────────────────────────────────────────────────────
//
// `TenantContext` is the AsyncLocalStorage payload every request carries
// (§8.1 layer 2). `TenantScopedDb` reads it to auto-inject `workspace_id`
// into every query; a missing context is a runtime error before any DB
// call is issued.

export interface TenantContext {
  readonly workspace_id: WorkspaceId;
}

// ── Effective permissions (§8 ADR 0015) ────────────────────────────────────
//
// `AccessPath` is the shape a capability handler declares (or the
// dispatcher computes from input) to identify what the principal is
// trying to reach. Policy evaluation reads AccessPath + Principal and
// returns allow | deny.

export type SubBlockSelector = { readonly __brand: "SubBlockSelector" };

export interface AccessPath {
  readonly workspace_id: WorkspaceId;
  readonly doc_id?: DocId;
  readonly block_id?: BlockId;
  /** Reserved; always null in v1 per §8.2 + ADR 0015. */
  readonly selector?: SubBlockSelector | null;
}
