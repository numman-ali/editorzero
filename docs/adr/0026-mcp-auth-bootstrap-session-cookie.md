# ADR 0026 — MCP first-slice: transitional cookie auth + deliberately stateless

**Status:** Accepted (landed 2026-04-21)
**Date:** 2026-04-20
**Deciders:** @numman

## Context

ADR 0009 + ADR 0021 pin the canonical MCP target for editorzero:

- **Transport** — `@modelcontextprotocol/sdk@^1.29` paired with `@hono/mcp@^0.2.5`'s `StreamableHTTPTransport` mounted at `app.all('/mcp', ...)` on the same Hono trunk that serves `/api/v1/*`. Streamable HTTP only; stdio dropped (ADR 0021:14).
- **Auth** — OAuth 2.1 resource-server via `@better-auth/mcp`'s `withMcpAuth` / `mcpAuthHono` middleware, RFC 9728 protected-resource metadata, RFC 7591 DCR, RFC 8707 audience validation, PKCE S256 mandatory. Agent tokens accepted as bearers via `@better-auth/api-key`.
- **Tools** — every `mutation` + `read` capability surfaces as a tool; `humanOnly` capabilities filter out (ADR 0009:781, architecture.md §15.1).

The ADRs do not pin two smaller first-slice choices:

1. **First-slice auth posture.** The canonical OAuth 2.1 + DCR + RFC 9728 story is a large slice in its own right — mostly auth plumbing, not MCP plumbing. ADR 0025 bootstrapped CLI with session cookies instead of blocking on device-flow prerequisites; the same pattern works here.
2. **Session posture.** `@hono/mcp`'s `StreamableHTTPTransport` runs stateless-by-default (no `sessionIdGenerator`) or stateful (session headers + event store for resumability). The MVP tool-only scope (no resources, no prompts, no long-running tool calls) does not require the stateful features.

This ADR is **narrow by construction** (Codex review push): it records only the transitional-auth and stateless choices. The wider "how MCP works" material lives in ADR 0009 + ADR 0021; restating it here would add drift risk without adding clarity.

## Options considered

### A. Full OAuth 2.1 + DCR up-front

Wire `@better-auth/mcp` (`mcpAuthHono` middleware + `oAuthProtectedResourceMetadata` mount), `@better-auth/oauth-provider` for DCR/PKCE, implement `resolveTenantAudience(host)` for custom-domain multi-tenancy, add `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server` routes.

**Pros.** End-state correct; MCP spec-idiomatic.

**Cons.** Large slice; most of it is OAuth plumbing, not MCP plumbing. Validating `@better-auth/mcp` against this tree is itself unstarted work; landing it and the registry-driven tool loop in one slice compounds two unverified pieces. Same "don't pull forward the full auth story" pattern ADR 0025 rejected.

### B. Session-cookie transitional — CHOSEN (bounded bootstrap)

MCP clients send the `Cookie: session_token=...` header on `POST /mcp`. The existing `createPrincipalMiddleware` (live post-ADR 0024, proven in `auth-chain.integration.test.ts`) resolves the Principal from the BA session and attaches it to `c.var.principal` — the same chain `/docs/*` already uses. The MCP adapter reads `c.var.principal` and binds tool execution to that request-local value (see commitment 1 for the architectural commitment; the exact transport/server object lifetime is a slice-1 implementation choice).

**Pros.** Works against today's stack. Zero new auth plumbing — the principal middleware already exists, the session-cookie flow already works for `/docs/*`, `/auth/*` already mints sessions, and `/infra/whoami` (ADR 0025) already returns the Principal shape. The registry → MCP-tool infrastructure ships independently of the OAuth rollout; when OAuth+DCR lands, the cookie-reading middleware swaps for the bearer-reading equivalent and nothing else changes. Same spirit as ADR 0025.

**Cons.** MCP spec canonically expects bearer tokens; cookies are non-idiomatic for MCP clients. External clients built against the MCP spec (MCP Inspector, Claude Desktop's built-in connector) assume bearer flow and will not work until the OAuth slice lands. Cookie-speaking clients for slice 1 are therefore in-tree test harnesses + self-hosted agent harnesses that can be taught the cookie step.

### C. Bearer PAT via `@better-auth/api-key` only

Every MCP client authenticates via a long-lived PAT minted through an admin surface.

**Pros.** Idiomatic MCP (bearer tokens).

**Cons.** PAT-issuance UX doesn't exist — same chicken-and-egg ADR 0025 rejected for CLI. No way to mint a first PAT without direct DB access. Adopting PATs for MCP while CLI uses cookies also splits two auth stories that should move together.

## Decision

**Adopt option B for slice 1 as a bounded transitional bootstrap; make stateless an explicit simplifying constraint, not an accidental default; reject any half-measures that advertise OAuth semantics while still requiring cookies.**

### Load-bearing commitments

1. **Principal resolves via the Hono middleware chain; `authInfo.extra` is not used as an editorzero DI channel.**

   The `/mcp` Hono route runs the existing `createPrincipalMiddleware` before any MCP adapter code executes. Tool execution binds to that request-local `c.var.principal` value. The alternative — registering tools once at boot and smuggling the Principal through `authInfo.extra.principal` on `RequestHandlerExtra` — couples editorzero's internals to an MCP-spec field (`RequestHandlerExtra.authInfo.extra`) as a DI channel. `authInfo.extra`'s schema is the SDK's, not ours; tightening or redefinition there would silently break our contract. Keeping the Hono-owned Principal off `authInfo.extra` and on `c.var` keeps MCP-spec territory and editorzero territory cleanly separated.

   **Transport/server object lifetime is an implementation detail, not a commitment of this ADR.** Slice 1 may realize this with request-scoped `McpServer` + `StreamableHTTPTransport` construction because statelessness and tools-only scope make that the simplest safe shape — illustrated below — but a future implementation that keeps the server shared and injects the per-request Principal via a different Hono-owned seam does not require reopening this ADR:

   ```ts
   app.all("/mcp", principalMiddleware, async (c) => {
     const principal = c.var.principal;
     const server = new McpServer({ name: "editorzero", version: VERSION });
     for (const cap of registry.list().filter(isMcpTool)) {
       server.registerTool(cap.id, toToolConfig(cap), async (args) => {
         return await runTool(cap, { principal, input: args, dispatcher });
       });
     }
     const transport = new StreamableHTTPTransport();
     await server.connect(transport);
     return transport.handleRequest(c);
   });
   ```

   When slice 2 introduces bearer tokens, the only change is what populates `c.var.principal`; the architectural commitment — Principal comes from the Hono chain, not `authInfo.extra` — stands.

2. **Deliberately stateless.** No `sessionIdGenerator` on `StreamableHTTPTransport`, no event store, no `Mcp-Session-Id`, no `Last-Event-Id` resume, no `tool_call_id` persistence. Protocol handshake carries no session continuation across requests. This is not a default we're inheriting — it's a simplifying constraint that matches slice 1's scope: tools-only, no resources, no prompts, no long-running call durations, no server-initiated notifications. The SDK's own docs position stateless Streamable HTTP as the simple API-style mode and stateful sessions as the resumability / long-lived option (Codex review push).

   Stateful sessions are **the next surface slice, not a punt.** The revisit triggers (below) name the workloads that flip the choice.

3. **Registry → tool loop.** One `server.registerTool(cap.id, toolConfig, handler)` per capability where `cap.surfaces.includes("mcp")` AND `cap.humanOnly !== true`. The MCP SDK 1.x `inputSchema` accepts a zod raw shape (`{ key: z.ZodType }`), not a `z.object(...)` — `toToolConfig(cap)` unwraps `cap.input.shape` and passes it directly.

4. **Error shape — three-way cut** (Codex review push):

   - **`EditorZeroError` and dispatcher business denials** (auth_expired / permission_denied / validation / not_found / handler-thrown) → explicit `{ isError: true, content: [{ type: "text", text: "<human message>" }], structuredContent: { error: { code, help } } }`. The tool handler catches and maps. The LLM sees structured error metadata via `structuredContent` (MCP-native framing) alongside a rendered text summary.
   - **Protocol-level errors** (bad method, invalid params, protocol negotiation) → `throw new McpError(ErrorCode.InvalidParams, ...)` (SDK converts to JSON-RPC error). The SDK emits these automatically on `inputSchema` validation failure; manual throws cover the "no principal" case and similar adapter-internal contract violations.
   - **Unexpected handler exceptions** — not actively reclassified. The SDK catches and converts to `{ isError: true, content: [{ type: "text", text: err.message }] }` — these ARE model-visible, which is acceptable for the first slice since the blast radius is narrow (dispatcher and capability handlers go through `EditorZeroError` already). A future refinement can wrap the handler in a catch-all that collapses unexpected errors to a generic internal-error envelope; slice 1 doesn't need it.

   **AXI framing deliberately not used.** AXI is the CLI contract (stdout envelope, exit codes). MCP's contract is `CallToolResult`. Both carry the same semantic payload (`{ error: { code, help } }` structure) but the transport envelope is MCP-native here.

5. **`humanOnly` capabilities filter out of the tool list.** `createMcpServer(registry, opts)` skips capabilities whose `humanOnly === true`. The MCP client's `list_tools` response does not include the tool at all. Rationale: `humanOnly` marks capabilities agents have no legitimate path to; surfacing them would imply otherwise. An ops-agent that legitimately needs a `humanOnly` surface is an explicit capability/surface-policy change, not an accidental consequence of the generic adapter (Codex review push).

6. **No OAuth discovery metadata mounted in slice 1.** A `/mcp` endpoint that expects cookies but advertises `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server` is worse than either posture alone — clients that follow the MCP spec's OAuth flow hit advertised endpoints expecting DCR and receive silent auth failures downstream. Either transitional-cookie-and-say-so-plainly (slice 1) or real OAuth (future slice). Don't blur them (Codex review push).

### Peer-review trail (Codex, 2026-04-20)

**Round 1 (pre-draft).**

1. **`authInfo.extra.principal` smuggling rejected.** Original outline proposed an `mcpAuthBridge` middleware that serialized `Principal` into `authInfo.extra`; Codex pushed for Principal to flow via the Hono middleware chain instead, keeping editorzero's internal types off an MCP-spec DI channel whose schema the SDK could tighten. Applied (commitment 1).
2. **Stateless framing sharpened.** Original outline described stateless as the default. Codex pushed for framing it as a deliberate simplifying constraint aligned with the tools-only MVP scope. Applied (commitment 2). Stateful is named as the next slice with explicit revisit triggers, not deferred indefinitely.
3. **Error-shape three-way cut.** Original outline conflated "let SDK default handle uncaught" with "protocol-level errors." Codex pushed for a three-way cut — `EditorZeroError` → explicit `isError`; protocol → `McpError`; unexpected → SDK default — and called out that SDK 1.x's default converts thrown exceptions to model-visible `isError: true` (which I had glossed). Applied (commitment 4). Also dropped "AXI shape verbatim" framing; MCP uses `structuredContent` + content[] for MCP-native framing of the same semantic payload.
4. **`humanOnly` filter confirmed.** Codex agreed; no change.
5. **No half-measures on OAuth discovery.** Codex added this caution not in the original outline: mounting RFC 9728 metadata while requiring cookies on `/mcp` is actively worse than either end-state. Added as commitment 6.

**Round 2 (post-draft).**

6. **Commitment 1 narrowed: principal-via-Hono is the architectural commitment; per-request `McpServer`+`StreamableHTTPTransport` construction is a slice-1 implementation illustration, not an ADR-level mechanism.** Round-1 draft wording froze object lifetime into commitment 1 ("Request-scoped `McpServer` + `StreamableHTTPTransport`, principal via Hono closure"). Codex pushed: freezing per-request transport lifetime in the ADR implicitly forecloses the GET/SSE shape `StreamableHTTPTransport` already supports and would make this ADR fight the first implementation choice to relax. Re-scoped commitment 1 to "Principal resolves via the Hono middleware chain; `authInfo.extra` is not used as a DI channel." Per-request construction is kept as an illustrative code block tagged as a slice-1 implementation option, not an architectural commitment. Applied.

### Deferred

- **OAuth 2.1 + DCR + PKCE via `@better-auth/mcp`/`@better-auth/oauth-provider`** — revisit when the first external MCP client integration is planned (MCP Inspector, Claude Desktop connector, third-party agent).
- **RFC 9728 protected-resource + RFC 8414 authorization-server metadata routes** — land alongside OAuth 2.1 (not before; see commitment 6).
- **`resolveTenantAudience(host)` for custom-domain multi-tenancy** — lands with OAuth 2.1.
- **PAT / agent-token bearer paths via `@better-auth/api-key`** — lands when the agent-auth slice does; that slice widens CLI + MCP auth surfaces together.
- **Stateful sessions** — `Mcp-Session-Id`, `Last-Event-Id` resume, `tool_call_id` persistence, event store for SSE replay.
- **Resources + Prompts** — MVP is tools-only. Resources (`editorzero://workspace/{id}/doc/{id}`) and prompts (agent-authoring templates) land as their own capability categories once authoring-context APIs exist.
- **Server-initiated notifications** — would require stateful sessions; same revisit trigger.

## Revisit triggers

- **First external MCP client integration that doesn't speak cookies** (MCP Inspector, Claude Desktop connector, third-party agent) → OAuth 2.1 + DCR slice.
- **Agent-token auth slice lands** (`@better-auth/api-key`) → widens MCP auth to bearer PAT path.
- **Tool-call durations exceed what stateless re-negotiation can handle** → stateful sessions slice.
- **An agent workload requires conversational state across tool calls** → stateful sessions slice.
- **`@better-auth/mcp` reaches a stable shape validated against this tree** → opens the OAuth path.

## References

- **ADR 0009** — MCP SDK choice (`@modelcontextprotocol/sdk` 1.x stable; `@hono/mcp` for Hono integration).
- **ADR 0021** — Surface transport topology (Streamable HTTP only; stdio dropped; co-mounted with `/api/v1/*`).
- **ADR 0024** — `workspace_members` + principal resolution via session cookie (prerequisite for option B).
- **ADR 0025** — CLI auth bootstrap (direct precedent: session-cookie transitional behind a seam).
- **`@modelcontextprotocol/sdk@1.29.0`** — `McpServer`, `registerTool`, `CallToolResult`, `McpError`.
- **`@hono/mcp@0.2.5`** — `StreamableHTTPTransport`.
