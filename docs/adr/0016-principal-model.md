# ADR 0016 — Principal model: humans and agents as peer types

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Red-team (#10) flagged that "humans and agents as peer principals" was asserted, not designed. Better Auth does not give us this shape out of the box. We need: distinct principal types, per-agent rate limits separate from the owning human, per-agent audit attribution that survives token rotation, revocation that cascades to in-flight MCP sessions, and a scope model narrower than OAuth's default.

## Decision

### `Principal` is polymorphic with a `kind` discriminator

```ts
type Principal =
  | { kind: "user",  id: UserId,  workspace_id: WorkspaceId,
      roles: Role[],  session_id: SessionId | null }
  | { kind: "agent", id: AgentId, workspace_id: WorkspaceId,
      owner_user_id: UserId | null,   // nullable: some agents are workspace-owned
      scopes: Scope[],
      token_id: TokenId,
      acting_as?: UserId              // optional human delegation
    }
```

One principal table in the DB, one auth middleware, one audit shape. Joins into `audit_events` carry the full `principal_ref` (kind + id + token_id where applicable) so attribution survives token rotation: if token T1 is rotated to T2, the audit for actions done via T1 still says "agent X acting via token T1."

### Agent identity is workspace-scoped and owner-attributable

- Agents are created by a human (or by another agent with `agent.create` capability). The creator is recorded in `agent.created_by`.
- Agents can optionally be workspace-owned (no single human owner) so that a workspace-wide automation does not die when its creator leaves.
- An agent's tokens are rotatable and individually revocable. Revocation is immediate: in-flight MCP sessions (ADR 0009) see their next message denied; HTTP request middleware rejects on the next call.

### Scopes

Agent tokens carry scopes narrower than OAuth's default. Scope vocabulary:
```
doc:read, doc:write, doc:delete, doc:publish
block:read, block:write
comment:read, comment:write, comment:resolve
search:read
workspace:read, workspace:admin
permission:grant, permission:revoke
agent:create, agent:revoke
```

Scopes are multiplicatively combined with workspace-level permissions: `capability allowed iff (principal has scope) AND (principal has workspace permission)`. An agent with `doc:write` but no `workspace_member` cannot write. An agent with `workspace_member` but no `doc:write` cannot write. Defense-in-depth.

### `ActingAs` delegation

Some agent actions are on behalf of a specific human (e.g., a coding agent invoked by Alice to refactor doc X). The token carries `acting_as: alice.user_id`. Audit, rate limits, and permission checks see:
- **Attribution:** rows show "agent BOT acting_as alice" — both are auditable.
- **Permission:** effective permission is `intersect(agent.scopes, alice.permissions)` — an agent cannot exceed the delegator.
- **Rate limits:** the agent's per-agent bucket AND alice's per-user bucket both apply; whichever depletes first rate-limits the action.

### Per-principal rate limits

Separate buckets from the owning human. No shared ceilings. Default daily caps (configurable):
- Human PAT: 100k requests/day, 10k writes/day.
- Agent token: 50k requests/day, 5k writes/day.
- Per-capability sub-buckets (e.g., `doc.write` at 120/min/principal; see ADR 0009 capability metadata).
- Audit write rate limit (ADR 0009 #11): 1k events/min with burst 3k; circuit breaker on sustained overflow suspends the principal.

### Revocation cascade

When a token is revoked:
1. The token row is marked `revoked_at = now()`.
2. Active HTTP requests complete (read-only middleware no-op); subsequent requests with that token fail auth.
3. In-flight MCP Streamable HTTP sessions bound to that token are forcibly closed with an auth-error message.
4. In-flight Hocuspocus WebSocket sessions bound to that token are closed; the client sees a disconnect and must reauthenticate.
5. Scheduled jobs the principal enqueued continue (they carry their own authenticated principal snapshot); future enqueues fail.
6. Audit records `revoke` with human operator who triggered it.

When a compromised agent token is revoked, the human owner's sessions are not affected. Containment is per-token, not per-owner.

### Agent creation flow

1. Human with `agent:create` scope hits `POST /api/agents` with `{ name, scopes, acting_as? }`.
2. System creates agent principal + mints a long-lived token; token shown once in response.
3. Audit event `agent.created` with full scope list, creator, workspace.
4. Agent is usable immediately for MCP / API / CLI.

## Consequences
- Humans and agents are first-class in every subsystem — auth, audit, rate limits, permissions, revocation — because they share the same `Principal` shape.
- Token rotation does not break audit attribution (token id is preserved in audit rows even after the token is revoked).
- Delegation model (`acting_as`) allows agents to act on behalf of a human without forging identity — the delegation is explicit and visible.
- Compromise is contained per-token, not per-owner.
- Capability metadata (ADR 0009) + scope intersection (above) give us fine-grained access control without building a policy engine from scratch.

## Revisit triggers
- A multi-agent workflow requires an agent to delegate to another agent; currently `acting_as` is single-level. Revisit to support delegation chains.
- Scope vocabulary grows too coarse; a PBAC-style attribute model may be needed.
- A compromise class the revocation cascade does not contain (e.g., a forged audit row); harden the attribution pipeline.
