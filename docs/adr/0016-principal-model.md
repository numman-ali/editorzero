# ADR 0016 — Principal model: humans and agents as peer types

**Status:** Accepted (post-refresh)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

## Context
v1 designed a custom principal model. The refresh revealed Better Auth now ships `@better-auth/agent-auth` (v1.5.6, Mar 22 2026) implementing the Agent Auth Protocol plus `@better-auth/api-key` for long-lived revocable scoped tokens. This shrinks the custom work to the principal-spine abstraction plus per-tenant audience handling plus Hocuspocus-specific revocation cascade.

**Principal type stays polymorphic**; Better Auth handles the credential lifecycle.

## Decision

### `Principal` shape

```ts
type Principal =
  | { kind: "user",  id: UserId,  workspace_id: WorkspaceId,
      roles: Role[], session_id: SessionId | null }
  | { kind: "agent", id: AgentId, workspace_id: WorkspaceId,
      owner_user_id: UserId | null,
      scopes: Scope[],
      token_id: TokenId,
      token_kind: "agent-auth" | "api-key",
      acting_as?: UserId }
```

One principal table in the DB. One auth middleware produces a `Principal` for every request regardless of credential source (Better Auth session, PAT, API key, agent-auth token). The capability dispatcher (ADR 0015) sees only `Principal`.

### Credential sources — delegated

| Credential | Source | Plugin |
|---|---|---|
| Human session | cookie | `better-auth` core |
| Human PAT | bearer | `@better-auth/api-key` with `principal.kind = "user"` tag |
| Agent token (long-lived, workspace-scoped) | bearer | `@better-auth/api-key` with `principal.kind = "agent"`, `token_kind = "api-key"` tag |
| Agent token (short-lived, delegated via Agent Auth Protocol) | bearer JWT with `sub` + `act.sub` | `@better-auth/agent-auth`, `token_kind = "agent-auth"` |
| MCP OAuth 2.1 bearer | bearer | `@better-auth/oauth-provider` → MCP middleware (ADR 0009) |
| SSO (OIDC/SAML) | auth flow → session | `@better-auth/sso` |

### Agent creation and ownership
- Agents created by a human with `agent:create` scope (or by an agent that has `agent:create` in its scopes).
- `owner_user_id` is set to creator, or nullable for workspace-owned automations.
- Audit captures creator and workspace.
- `@better-auth/api-key` carries `referenceId = workspace_id` for per-workspace scoping; scope list lives in the key's `permissions`.
- Agent tokens are revocable; `@better-auth/api-key`'s revoke API + our audit hook emit `agent_token.revoked` event.

### Scopes (vocabulary — same as v1)
```
doc:read, doc:write, doc:delete, doc:publish
block:read, block:write
comment:read, comment:write, comment:resolve
search:read
workspace:read, workspace:admin
permission:grant, permission:revoke
agent:create, agent:revoke
```

Multiplicatively combined with workspace-level permissions at capability dispatch (ADR 0015): `allowed iff (token.scopes contains S) AND (principal has workspace permission for S)`.

### `ActingAs` delegation — delegated to Agent Auth
`@better-auth/agent-auth`'s `modes: ["delegated", "autonomous"]` covers it. Delegated tokens carry `sub: agent_id` + `act.sub: human_id`. Our capability dispatcher reads both and applies effective permissions as `intersect(agent.scopes, human.permissions)` — an agent cannot exceed the delegator.

Rate limits apply to both buckets — agent's and human's — whichever depletes first rate-limits the action.

### Per-principal rate limits
Per `@better-auth/api-key`'s `rateLimitMax` + `rateLimitTimeWindow` — configurable per key, configurable per workspace default. Audit rate-limit (ADR 0009 §audit rate limiting) applies on top.

Defaults (tunable):
- Human PAT: 100k req/day, 10k writes/day.
- Agent API-key: 50k req/day, 5k writes/day.
- Per-capability sub-buckets from capability metadata (ADR 0009).
- Audit: 1k events/min sustained, burst 3k, circuit-break on sustained overflow.

### Revocation cascade (ours to own)
Better Auth revokes the credential; we cascade the consequences across subsystems Better Auth doesn't know about:
1. Better Auth marks the token `revoked_at`.
2. HTTP middleware rejects on next call (Better Auth).
3. **MCP Streamable HTTP sessions bound to the token are forcibly closed** — our code, on the MCP session manager (ADR 0009).
4. **Hocuspocus WebSocket sessions bound to the token are closed with an auth error** — our code, on Hocuspocus's `onAuthenticate` re-validation path.
5. **Scheduled jobs enqueued by the principal continue** (they carry their own auth snapshot); future enqueues under the revoked token fail.
6. Audit records `revoke` with operator.

When an agent token is compromised and revoked, the owning human's session is **unaffected**. Per-token containment.

### Audit integration
Every credential event (issue, refresh, rotate, revoke), every `acting_as` delegation chain, every capability invocation, every rate-limit breach lands in our `audit_events` table (ADR 0017 retention). Hooks: Better Auth's `hooks.before` / `hooks.after`, Agent Auth's `onEvent`.

### Per-tenant canonical URL / audience — DIY
Better Auth's `referenceId` plumbing plus our `resolveTenantAudience(host)` helper (ADR 0009 / ADR 0010) owns this. Custom-domain tenants get per-tenant `aud` on issued tokens; token validation checks the Host header maps to the token's audience.

## Consequences
- The principal spine is ours; credential lifecycle is Better Auth's.
- Agent-as-first-class is real: distinct `kind`, distinct scope model, distinct rate limits, distinct audit attribution, distinct revocation semantics — none of which are shared with the owning human.
- Delegation via Agent Auth Protocol gives agents a structured `acting_as` without forging identity; compromise contained per-token.
- We own Hocuspocus session revocation, MCP session revocation, and per-tenant audience — the three places Better Auth cannot reach.
- Agent Auth Protocol is marked unstable through 2026-H2; we wrap it behind the `Principal` abstraction so protocol churn doesn't ripple through capability code.

## Revisit triggers
- Multi-agent workflows require multi-level `acting_as` (agent → agent → human) beyond Agent Auth Protocol's single-level support.
- Agent Auth Protocol breaking changes we cannot pin through.
- A per-agent capability model emerges (e.g., declarative "this agent may only author blocks of type X") that scope vocabulary cannot express — introduce PBAC-style attributes.
