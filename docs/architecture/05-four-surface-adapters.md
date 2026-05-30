## 5. Four-surface adapters

Invariant #4 is the **target parity contract**, not current-tree status: as of P3.7 the shared registry/dispatcher/sync primitive + Hono trunk + CLI surface + MCP adapter have all landed (`packages/api-server`, `packages/api-client`, `packages/mcp-server`, `apps/cli`); still absent are `apps/{app,admin}` (Web UI) and `packages/contract-tests` (cross-surface parity harness). The subsections below describe the intended adapters and matrix; for surfaces that have landed, hand-written adapter glue is **forbidden** — the three existing surfaces all derive from the capability registry.

> **Read [ADR 0021](../adr/0021-surface-transport-topology.md) before implementing any §5.x slice.** It names the Hono app as the single trunk, commits each eventual surface adapter (Web UI SPA / CLI / MCP) to consuming it via typed RPC (`hc<AppType>` — in-process via `app.request` for server-side callers, HTTP for clients), drops MCP stdio in favour of Streamable HTTP, names `citty` as the CLI framework, and pins `@hono/mcp` as the MCP integration. The subsections below describe the resulting surfaces; the ADR is the why.

### 5.1 HTTP API (Hono)

- Mounted under `/api/v1/*` and `/mcp` (via `@better-auth/mcp`'s `mcpAuthHono`).
- Route generator iterates the registry; per capability emits a `hono/factory` handler wired with `hono-openapi` `describeRoute` + `validator` (code-first; [ADR 0029](../adr/0029-api-package-shape.md)).
- Auth middleware: Better Auth resolves credential → `Principal`; sets `TenantContext` in `AsyncLocalStorage`.
- Dispatcher middleware: looks up capability, validates input via zod, checks `requires` against `Principal.scopes` (and workspace role), enforces `rateLimit`, calls handler, validates output, writes audit, emits OTel span.

### 5.2 CLI (Bun-compiled binary)

- **Framework: `citty`** (Unjs, near-zero deps, compile-clean under `bun build --compile`). commander / oclif / clipanion evaluated and rejected — see [ADR 0021](../adr/0021-surface-transport-topology.md).
- **Transport: HTTP client of the API trunk** via `hc<AppType>(baseUrl)` from `hono/client`. The CLI never holds the dispatcher directly; it is a first-class HTTP consumer of `/api/v1/*` identical to any other external client.
- One subcommand per capability generated from the registry: `editorzero doc create --workspace ws1 --title "..."`.
- Argument parser built from the capability's zod input (registry source) via a citty `defineCommand` loop.
- **Auth ([ADR 0025](../adr/0025-cli-auth-bootstrap-credential-store.md))**: first-slice bootstrap is email+password → session cookie stored in `~/.editorzero/credentials` (mode 0600), resent on every `hc<AppType>` call. `AuthCredentialStore` seam in `apps/cli/src/auth/` keeps future device-flow / PAT / agent-auth stores as drop-in implementations — command tree doesn't change on credential-model swap. Dual-mode input: interactive prompt in TTY, `--password-stdin` in non-TTY (AXI "no interactive prompts" in agent mode; standard `podman login --password-stdin` idiom). 401s fail loud with AXI-shaped envelope `code: "auth_expired"` + re-login hint. Device flow and PAT paste deferred to standalone ADRs gated on Web UI / admin-surface slices.
- **`ez auth whoami`** calls `/infra/whoami`, a trunk route that wraps `c.get("principal")` and returns editorzero's `Principal` shape (`kind`, `id`, `workspace_id`, `roles`, `session_id` / `token_id`). **Not** BA's `/auth/get-session` — that returns BA session/user state, which diverges from what the dispatcher/gate enforces. Same middleware chain as capability routes → single source of principal truth.
- **Output governed by [AXI](https://github.com/kunchenguid/axi) in agent mode; [clig.dev](https://clig.dev/) in TTY mode.** See ADR 0021 for the full commitments. Summary:
  - Agent mode (non-TTY or `--agent`): minimal default schemas, pre-computed aggregates, structured errors **on stdout** with typed `code`, idempotent mutations exit 0 on no-op, no prompts, content-first home view.
  - TTY mode: table / YAML, colour (respecting `NO_COLOR`), clig.dev error conventions, human prose.
  - **Stdout format for agent mode is pending eval** — TOON, JSON, JSONL, YAML-compact evaluated on token cost AND agent task-completion success. JSON is the interim default until the eval runs (ADR 0021 Decision §6).
- **Session-hook self-install** for Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`) on first invocation. `SessionStart` hook emits a compact workspace dashboard as ambient context, in whichever agent-mode serializer the preceding bullet currently selects (JSON until the ADR 0021 serializer eval runs). Absolute-path hook command, self-heals on relocation.
- Distribution: `bun build --compile --bytecode` per target tuple (linux-amd64, linux-arm64, darwin-amd64, darwin-arm64, windows-amd64). Binary ~60MB.

### 5.3 MCP (`@modelcontextprotocol/sdk` 1.x stable)

Per ADR 0009 + [ADR 0021](../adr/0021-surface-transport-topology.md), capabilities map to MCP concepts:

- **Integration**: `@hono/mcp`'s `StreamableHTTPTransport` mounted at `app.all('/mcp', ...)` inside the same Hono app that serves `/api/v1/*`. `xmcp` and `FastMCP TS` evaluated and rejected in ADR 0021 (xmcp has no Hono adapter and its file-system routing fights the capability registry; FastMCP wraps Hono backwards and duplicates Better Auth).
- **Tools**: every `mutation` + `read` capability becomes a tool, registered programmatically via `server.tool()` in a registry loop. Input schema = capability.input. Output schema surfaced via the SDK's `outputSchema`.
- **Resources**: pinnable context — `editorzero://workspace/{id}/doc/{id}` (rendered Markdown per ADR 0013 fidelity), `editorzero://workspace/{id}/doc-tree`, `editorzero://workspace/{id}/schema`. Each resource is a thin wrapper around a read capability.
- **Prompts**: authoring templates; populated from a registry extension (not part of MVP capability set).
- **Toolsets**: grouped via `X-MCP-Tools` header; `--read-only` mode filters to category=`read`.
- **Transport**: **Streamable HTTP only**. Stdio transport is **dropped** (ADR 0021) — local-subprocess MCP agents point at `http://<host>/mcp` (same auth story as remote). HTTP+SSE remains a deprecated fallback per MCP spec.
- **Auth**: `withMcpAuth` / `mcpAuthHono` (`@better-auth/mcp`) in front of the transport on the same Hono route. OAuth 2.1 DCR + PKCE S256 + RFC 8707 audience; `resolveTenantAudience(host)` binds custom-domain tenants.
- **Reconnect**: keepalive 15 s, `Mcp-Session-Id` + `Last-Event-Id` resume, `tool_call_id` persisted 24 h for interrupted calls.

### 5.4 Web UI (Hono trunk + Vite/React SPA — ADR 0027–0033)

> **Topology re-decided 2026-05-30 ([ADR 0027](../adr/0027-web-ui-topology.md)–0033), superseding the Next.js design ([ADR 0005](../adr/0005-ui-framework.md)).** The Hono trunk is the top-level server; there is no framework above it. The Next-specific machinery this section used to describe (Server Actions/RSC, header-forwarding across a synthesized request, `"use cache"`) is retired.

- **In-process typed RPC is preserved** ([ADR 0021](../adr/0021-surface-transport-topology.md), [ADR 0027](../adr/0027-web-ui-topology.md)). `@editorzero/api-client` still exports `createServerClient()` = `hc<AppType>` bound to `app.request.bind(app)` — full middleware chain (Better Auth → `Principal` → tenant scope → rate limit → dispatcher), zero TCP. It now serves SSR-shell / reader-render callers rather than Next Server Actions/RSC; the SPA uses `createHttpClient()` over same-origin fetch. Server-side callers never invoke the dispatcher outside this chain (invariant 5).
- **Same-origin auth** ([ADR 0030](../adr/0030-better-auth-mount.md)). Better Auth mounts directly on the trunk; SPA, RPC, and `/auth/*` share one origin → first-party `SameSite=Lax` cookies, no CORS, no synthesized-request header-forwarding allowlist (so no spoofed-tenant-hint risk), and the Better-Auth-in-`"use cache"` gotcha is moot.
- **Editor route is client-only** (`ssr: false`; [ADR 0031](../adr/0031-editor-substrate.md)). Bootstraps on BlockNote + `y-prosemirror` over the embedded Hocuspocus WebSocket; ejects to Tiptap v3 + an owned thin block layer (clean-start) fused with the version-history/track-changes slice ([ADR 0032](../adr/0032-version-history-track-changes.md)). Production collab is gated on **broadcast-after-commit** so a rolled-back SQL tx never leaves a mutation resident in the live `Y.Doc` (ADR 0027 / invariant 7).
- **Published docs are event-rendered static HTML** ([ADR 0027](../adr/0027-web-ui-topology.md)), replacing the `"use cache"` + `cacheLife` + `revalidateTag` design. An outbox consumer regenerates a published doc's HTML on **both** `doc.visibility_changed` (publish/unpublish/delete/restore) **and** `doc.updated` (content edits to an already-published doc) — keying on visibility alone was a staleness bug. Rendered via a neutral block-JSON→HTML projection (not BlockNote's `blocksToFullHTML`), written under `./data/published/<workspace>/<slug>.html(.br)`, served with `ETag` / `must-revalidate` (the shareable slug can't carry a content hash, so not `immutable`; only hashed sub-assets are `immutable`).
  - Cache/artifact key: composite (`workspace_id`, `doc_id`, `visibility_version`, content-hash). `visibility_version` remains a scalar per-doc counter bumped on `block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.delete`, `doc.restore`; the content-hash arm catches content edits to an already-published doc, which `visibility_version` does not move. Delete/restore must flip the public render 200↔404 (F5 + ADR 0017).
  - The outbox consumer (not a Server Action) re-renders on the events above and writes/evicts the static artifact; publish-snapshot-vs-live-latest semantics are a reader-slice product decision (ADR 0027).
  - Property test (`public-cache-invariance.prop.ts`, adapted to the artifact): after any sequence of `{block.set_visibility, doc.publish, doc.unpublish, doc.delete, doc.restore, block.update}`, the rendered public HTML contains no `visibility='internal'` block content as of that snapshot, and a soft-deleted doc renders 404 regardless of prior publish state — now asserted against the event-rendered artifact rather than a `"use cache"` key.
- `proxy.ts` resolves `Host` → workspace via `custom_domains` using a small in-memory LRU primed at startup and invalidated on `custom_domains` mutation. **In HA mode (F53):** `custom_domain.add`, `custom_domain.remove`, `custom_domain.verify` publish `custom_domains:invalidated` on the Redis pub/sub channel; each node's proxy LRU subscribes and evicts matching keys. LRU entries also carry a **60s TTL** as a safety net so that a missed pub/sub message self-heals within one minute.

### 5.5 Contract enforcement

Planned contract-test matrix (target shape once the surface adapters + `packages/contract-tests` land; not present in the tree today):

1. **Existence matrix** — for every `(capability, surface)` pair where the capability is type-compatible, a generated surface must exist and reach the same handler.
2. **Shared-fixture matrix** — the same capability invoked on each surface with the same input produces the same output + the same audit row (modulo surface-specific metadata).
3. **Error-parity** — permission denial and validation errors produce the same error code + shape across surfaces.

The matrix is generated from the registry, so once it lands "a new capability didn't add its MCP tool" fails contract tests without a hand-maintained checklist.

#### 5.5.2 Matrix dimensions and suppression (F42)

Without bounds, the matrix is `capability × surface × principal_profile × outcome` — combinatorial explosion. Formalized so every cell is either exercised or suppressed with a cited reason:

- **Matrix cell:** `{ capability, surface, principal_profile, outcome }` where `principal_profile ∈ { anonymous, member, admin, agent-basic, agent-delegated, agent-power }` and `outcome ∈ { allow, deny, validate_error }`.
- **Suppression rules (cell is skipped, not a test gap):**
  - **(a) `humanOnly` × agent principals** — skip. Capabilities marked `humanOnly: true` have a categorical deny for agents already enforced by dispatcher; no cell adds signal.
  - **(b) Capability not on surface** — skip. E.g. `doc.update_from_markdown` has `surfaces: ["api", "cli", "mcp"]`; UI cells are skipped.
  - **(c) Authorization-impossible outcome** — skip. `anonymous` × an admin capability has `allow` as impossible; only the `deny` cell runs.
  - **(d) Capability post-sunset (F72)** — `current date > capability.deprecated.sunset` → cell suppressed; matrix-snapshot diff flags removal for reviewer. Pre-sunset deprecated capabilities continue to exercise all cells.
- **Surface-specific metadata excluded from cross-surface equality:** the fixed list `["x-session-id", "x-request-id", "x-trace-id", "x-ratelimit-*"]`. Everything else must match byte-for-byte across surfaces.
- **Matrix snapshot.** The resolved matrix will be emitted as `contract-matrix.snapshot.json`, committed, and diff-reviewed. Adding a capability will update the snapshot in the same commit so reviewers see the delta.
- **Meta-test.** Planned `packages/contract-tests/test/meta.test.ts` will assert: **every possible cell either runs or matches a suppression rule with a cited reason.** "Just didn't add this one" is a meta-test failure, not a silent gap.
