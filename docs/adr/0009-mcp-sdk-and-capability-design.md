# ADR 0009 — MCP SDK and capability design

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
MCP server exposes the same capability surface as HTTP API and CLI. Spec baseline: `2025-11-25`. Transports: stdio (local) + Streamable HTTP (remote). Remote auth: OAuth 2.1 resource-server with RFC 8707 audience validation + DCR (RFC 7591).

Red-team flagged: #8 four-surface parity needs a named contract; #11 MCP audit-log flooding DoS; #23 Streamable HTTP idle/reconnect story; #24 DCR cleanup + per-tenant audience.

## Decision

### SDK and transports
- **SDK:** `@modelcontextprotocol/sdk` (TypeScript) — most spec-complete, matches our backend runtime (ADR 0002).
- **Transports:** stdio (local AI clients) + Streamable HTTP (remote). HTTP+SSE supported only as a deprecated fallback.

### Capability registry as single source of truth (red-team #8)

A single `packages/capabilities/src/*.ts` registry is the authoritative definition of every platform capability. Each capability is a typed record:

```ts
{
  id: "doc.update",
  input: ZodSchema,
  output: ZodSchema,
  requires: ["doc:write"],  // permissions, see ADR 0015
  auditCategory: "mutation",
  rateLimit: { per: "principal", bucket: "doc.write", per_minute: 120 },
  handler: async (ctx, input) => { ... },
}
```

**All four surfaces are generated or driven by this registry:**
- **HTTP API** — a route handler per capability, auto-registered, input/output validated via Zod.
- **CLI** — a subcommand per capability, auto-generated, argument parsing from the input schema.
- **MCP tools** — a tool per capability, tool schema derived from the input/output schemas.
- **Web UI Server Actions** — thin TypeScript wrappers, same input schema.

**Contract tests** assert (a) every capability has an HTTP route, CLI command, MCP tool, and Server Action; (b) all four surfaces produce identical results against a shared fixture set. Missing surface = CI fail.

### Tools / resources / prompts split
- **Tools** (actions): `doc_list`, `doc_get`, `doc_create`, `doc_update`, `doc_delete`, `doc_restore`, `doc_publish`, `block_upsert`, `block_list`, `doc_search`, `comment_list`, `comment_create`, `comment_resolve`, `permission_grant`, `permission_revoke`, `workspace_list`, `agent_token_*`.
- **Resources** (pinnable context): `editorzero://workspace/{id}/doc/{id}` (rendered Markdown), `editorzero://workspace/{id}/doc-tree`, `editorzero://workspace/{id}/schema`.
- **Prompts** (agent-authoring templates).
- **Toolsets** grouped (docs, blocks, search, publish, comments, permissions, admin) with an `X-MCP-Tools` header for gating; `--read-only` mode disables mutation toolsets.

### Auth (OAuth 2.1 resource-server)
- Expose `/.well-known/oauth-protected-resource` (RFC 9728).
- Enforce `aud` per tenant: **each tenant's canonical URL is its own audience**. Multi-tenant custom domains produce per-tenant audiences (`https://docs.acme.com/mcp` ≠ `https://docs.beta.com/mcp`); token issuer + resource indicator + audience claim must agree for each request.
- DCR (RFC 7591) enabled for remote AI clients.
- **DCR client lifecycle (red-team #24):** registered clients carry a `created_at` and `last_used_at`; cleanup job deletes clients unused for 90 days. Per-tenant DCR registration rate limit: 20 new clients/hour.
- PKCE required.
- Agent tokens (long-lived, workspace-scoped, rotatable; ADR 0016) accepted as bearer tokens on the same endpoint.

### Audit rate limiting (red-team #11)
- Every MCP tool call is audited via the capability layer (ADR 0015).
- **Per-principal rate limit on audit writes:** 1k events/min sustained, burst 3k. Overflow triggers identical-sequential collapse (repeated calls with same input within 1s collapse to a single row with `count`).
- **Circuit breaker:** sustained overflow for > 5 min suspends the principal (agent token disabled; human session terminated with an admin alert). **We never drop audit rows silently** — circuit-break is preferred to data loss.
- Monitored via OTel (ADR 0019).

### Streamable HTTP reconnect (red-team #23)
- **Keepalive:** server emits SSE heartbeat every 15s.
- **Resume token:** client receives `Mcp-Session-Id` header; on reconnect, sends `Last-Event-Id` to resume stream.
- **In-flight tool calls:** long-running tool calls carry a `tool_call_id`; on reconnect, client polls `GET /mcp/tool-calls/{id}` to resume results. Results stored durably for 24h.

## Consequences
- Single capability schema drives all four surfaces; parity is enforced at build time + runtime.
- Remote AI clients traverse the full OAuth 2.1 + DCR dance; local agents use PATs.
- MCP tool calls go through the same permission layer as HTTP (ADR 0015) — no authz duplication.
- Audit log is complete under flood scenarios; circuit-break rather than drop.
- Corporate proxies killing idle connections do not corrupt MCP sessions; resume is first-class.

## Revisit triggers
- MCP spec evolution (e.g., sampling redesign) that requires SDK change.
- Tool-count bloat makes client context windows expensive; promote common read paths to resources.
- Per-tenant audience handling meets an IdP that cannot mint per-audience tokens cleanly → introduce an internal audience-bridging layer.
