# ADR 0009 — MCP SDK and capability design

**Status:** Accepted (post-refresh)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

## Context
MCP server exposes the same capability surface as HTTP API and CLI. Spec baseline: `2025-11-25`. Transports: stdio (local) + Streamable HTTP (remote). Remote auth: OAuth 2.1 resource-server with RFC 8707 audience validation + DCR (RFC 7591).

Refresh material updates:
- **@modelcontextprotocol/sdk v2.0.0-alpha.2** (April 1 2026). Still alpha. Includes Standard Schema (Zod v4, Valibot, ArkType), Streamable HTTP GA, SSE deprecated, stateful sessions need configured `sessionIdGenerator`, in-memory event store for resume. **CVE-2026-0621 (ReDoS in `UriTemplate`)** patched.
- **Better Auth** now ships first-class MCP primitives: `@better-auth/oauth-provider` + `@better-auth/mcp` with `withMcpAuth` / `mcpAuthHono` middleware, `oAuthProtectedResourceMetadata(auth)` mount helper, `validAudiences` config, full DCR (RFC 7591), PKCE S256 mandatory, `referenceId` plumbing for per-tenant audiences.

## Decision

### SDK and transports
- **SDK:** **pin to `@modelcontextprotocol/sdk` latest 1.x stable** (v2 remains alpha). Re-pin to v2 on GA (tracked as a revisit trigger).
- **Transports:** stdio (local AI clients) + Streamable HTTP (remote). HTTP+SSE as deprecated fallback only.

### Capability registry as single source of truth
`packages/capabilities/src/*.ts` registry is authoritative. Each capability:

```ts
{
  id: "doc.update",
  input: ZodSchema,
  output: ZodSchema,
  requires: ["doc:write"],
  auditCategory: "mutation",
  rateLimit: { per: "principal", bucket: "doc.write", per_minute: 120 },
  handler: async (ctx, input) => { ... },
}
```

All four surfaces generated or driven by this registry:
- **HTTP API** — route handler per capability, auto-registered.
- **CLI** — subcommand per capability (cross-compiled via `bun build --compile`, see ADR 0002).
- **MCP tools** — tool per capability; schemas derived from input/output Zod.
- **Web UI Server Actions** — thin TypeScript wrappers, same input schema.

**Contract tests** assert every capability has all four surfaces and that all four produce identical results against shared fixtures.

### Tools / resources / prompts split
- **Tools** (actions): `doc_*`, `block_*`, `comment_*`, `permission_*`, `workspace_*`, `agent_token_*`, `doc_search`, `doc_publish`.
- **Resources** (pinnable context): `editorzero://workspace/{id}/doc/{id}` (rendered Markdown per ADR 0013 v2 fidelity tiers), `editorzero://workspace/{id}/doc-tree`, `editorzero://workspace/{id}/schema` (block-type schema for agent authoring).
- **Prompts** (agent-authoring templates).
- **Toolsets** grouped with `X-MCP-Tools` header for gating; `--read-only` mode disables mutations.

### Auth — delegated to Better Auth primitives
- **OAuth 2.1 resource-server:** `withMcpAuth` / `mcpAuthHono` middleware from `@better-auth/mcp`. Validates bearer tokens with audience check per `validAudiences` config.
- **`/.well-known/oauth-protected-resource`** (RFC 9728): `oAuthProtectedResourceMetadata(auth)` mount.
- **`/.well-known/oauth-authorization-server`**: `oAuthDiscoveryMetadata(auth)`.
- **Per-tenant audience (DIY plumbing):** Better Auth exposes `referenceId` on clients and `customAccessTokenClaims`; the "which audience for this Host header" mapping — given custom-domain multi-tenant deployments — is ours. Implementation: a `resolveTenantAudience(host)` helper called in the MCP auth middleware before calling into Better Auth.
- **DCR (RFC 7591):** `allowDynamicClientRegistration: true`. DCR client lifecycle: `created_at` + `last_used_at` stamped; **cleanup job deletes clients unused for 90 days** (ADR 0014 queue). Per-tenant DCR rate limit: 20 new clients/hour.
- **PKCE required** (S256 only, plain rejected — Better Auth default).
- **Agent tokens** (ADR 0016) accepted as bearer tokens on the same endpoint via `@better-auth/api-key`.

### Audit rate limiting (red-team #11 from Phase 1 v1)
- Every MCP tool call audited via capability layer.
- Per-principal rate limit on audit writes: **1k events/min sustained, burst 3k**. Overflow collapses identical-sequential calls (same input within 1s → one row with `count`).
- **Circuit breaker:** sustained overflow > 5 min suspends the principal. **Never drop audit rows silently.**
- Monitored via OTel (ADR 0019).

### Streamable HTTP reconnect
- **Keepalive:** server emits SSE heartbeat every 15s.
- **Resume:** `Mcp-Session-Id` header; client sends `Last-Event-Id` on reconnect.
- **In-flight tool calls:** `tool_call_id` persisted for 24h; `GET /mcp/tool-calls/{id}` resumes results.

## Consequences
- Single capability schema drives all four surfaces; parity enforced at build + runtime.
- Remote AI clients traverse full OAuth 2.1 + DCR dance; local agents use PATs / agent tokens.
- MCP tool calls go through the same permission layer as HTTP (ADR 0015) — no authz duplication.
- Audit log is complete under flood scenarios; circuit-break rather than drop.
- Better Auth primitives mean we don't hand-write RFC 9728 / RFC 8707 / RFC 7591 plumbing.

## Revisit triggers
- MCP SDK v2 goes GA → re-pin.
- MCP spec evolves in a way that requires custom middleware Better Auth doesn't support (e.g., new auth profile).
- Tool-count bloat makes client context windows expensive → promote common read paths to resources.
- Per-tenant audience handling meets an IdP that cannot mint per-audience tokens cleanly → introduce internal audience-bridging layer.
