# ADR 0021 — Surface transport topology: Hono app as trunk, typed RPC for all surfaces

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** @numman

## Context

`architecture.md §5` describes four surfaces (API / CLI / MCP / Web UI) and a capability dispatcher, but never commits to whether the surfaces are **peers sharing the dispatcher directly** or **clients of a single HTTP trunk**. That ambiguity was flagged as a drift risk: without a committed topology, each surface grows its own auth / tenanting / rate-limit glue, invariant 5 ("no surface re-implements permission logic") becomes aspirational rather than enforced, and the other agent implementing §5.1–§5.4 slices in P3.5 has no common contract to code against.

Three adjacent decisions surfaced together:

1. **In-process typed RPC is free in Hono.** `testClient(app)` and `app.request()` route through the full middleware chain with zero TCP / serialization overhead — it is the same code path as a real HTTP request (`Hono#request` → `Hono#fetch` → `#dispatch`), only the `Request`/`Response` objects are synthesized rather than parsed from a socket. Documented pattern, not a hack ([Hono RPC](https://hono.dev/docs/guides/rpc), [testing helpers](https://hono.dev/docs/helpers/testing)). This collapses the performance argument against "API as trunk" for server-side callers.
2. **MCP stdio transport is dead weight for this project.** Every non-trivial MCP client in 2026 speaks Streamable HTTP; local-subprocess stdio exists for niche no-network dev loops editorzero does not target. Dropping stdio removes an auth shim we'd otherwise carry forever.
3. **`xmcp` was named as a newer MCP library to evaluate.** It does not fit: no Hono adapter (only Next.js / NestJS / Express), filesystem-routed tools (`src/tools/*.ts`) fight our capability-registry-as-single-source model, WorkOS AuthKit is the marquee auth story and duplicates Better Auth, still pre-1.0. `@modelcontextprotocol/sdk` 1.x paired with `@hono/mcp` is the actual fit. `FastMCP TS` also rejected (wraps Hono backwards, duplicates Better Auth).
4. **CLI framework not previously named.** Research against clig.dev + `bun build --compile` constraints put `citty` (Unjs) ahead of `commander` / `oclif` / `clipanion`. oclif's runtime command discovery fights single-file compilation; citty's explicit-import subcommand tree compiles clean and lands ~60MB vs oclif's ~90MB.
5. **AXI (Agent eXperience Interface) is the governing agent-facing CLI standard.** Repo: https://github.com/kunchenguid/axi. The canonical spec for CLIs consumed by autonomous agents through shell execution. It resolves questions clig.dev does not address — notably that **errors go to stdout in structured form, not stderr**, because agents consume stdout. AXI prescribes minimal default list schemas (3–4 fields), truncation with `--full` escape hatches, pre-computed aggregates, definitive empty states, idempotent mutations (exit 0 on no-op), no interactive prompts, session-hook self-installation for ambient context at session start (Claude Code + Codex), and "content first" home views. **Adopted as the governing standard** for the editorzero CLI; clig.dev continues to govern human / TTY behaviour.
   - **TOON (Token-Oriented Object Notation — https://toonformat.dev/) is a candidate output format, not a commitment.** AXI itself recommends TOON for its ~40% token savings over JSON, but its maturity in the TS ecosystem is unverified as of 2026-04-18 and the real question — *does TOON measurably improve agent task-completion success, not just token count?* — has not been evaluated for editorzero's workload. Decision deferred to CLI-slice implementation time pending an eval harness (see Decision §5 below).

## Options considered

### A. Surfaces as peers, each holding the dispatcher (prior implicit state)

Server Actions + RSC call `dispatcher.dispatch(...)` in-process. Hono routes call the same dispatcher from inside an HTTP handler. MCP server calls the dispatcher from inside its tool handlers. CLI calls the dispatcher — either locally (if co-installed) or via HTTP (if remote).

**Pros.** No indirection for server-side callers; every path is a direct function call.
**Cons.** Auth, tenanting, and rate-limiting must be re-applied at every surface entry point. Four places `Principal` resolution can diverge. CLI is architecturally homeless — either embedded or HTTP client, never both coherent. The ambiguity itself is the problem.

### B. Hono app as the single trunk; every surface consumes it via typed RPC — CHOSEN

Auth, tenant scoping, rate limiting, dispatcher invocation, and audit wiring are mounted **once** on the Hono middleware chain. The surfaces differ only in their transport:

| Surface | Transport | Mechanism |
|---|---|---|
| Hono HTTP routes (`/api/v1/*`, `/mcp`) | TCP → socket → `app.fetch` | Next.js catch-all hands the Request to Hono |
| Next Server Actions | In-process → `app.request(req)` | `testClient(app)` or `hc('http://internal', { fetch: app.request.bind(app) })` |
| React Server Components | In-process → `app.request(req)` | Same as above; no Client Component involvement |
| CLI (Bun binary) | TCP → HTTP | `hc<AppType>(baseUrl, { headers: { Authorization } })` |
| Remote MCP client | TCP → HTTP → `/mcp` | `@hono/mcp` Streamable HTTP transport |

Same middleware chain, same `Principal` resolution, same capability dispatcher, same audit writer — always. The typed-RPC surface is `hc<AppType>` everywhere; only the fetch implementation differs (real network vs. `app.request`).

**Pros.** Invariant 5 enforced by construction — there is no other code path. Invariant 4 (parity) drops out of the registry-driven route generation. Drift between surfaces becomes mechanically impossible without editing the middleware chain itself. In-process callers pay zero network cost.
**Cons.** Server Actions need to forward `Cookie` / `Authorization` from `next/headers` into the synthesized `Request` (~10-line helper in `packages/api-client/src/server-action-client.ts`). Adds a thin `@editorzero/api-client` package that wraps `testClient` + `hc` with the header-forwarding pattern so callers never hand-roll it.

### C. Registry-generated transport-agnostic SDK

A codegen step emits `packages/sdk/` from the capability registry with two drivers: `inProcessDriver(dispatcher)` for server-side and `httpDriver(baseUrl)` for clients.

**Pros.** Surface-independent; the SDK is the contract, the registry is the source.
**Cons.** Strictly more machinery than option B for no additional invariant enforcement — option B already has the registry driving all surfaces via `@hono/zod-openapi` → `hc<AppType>`. A second codegen layer would duplicate what Hono's type inference already gives us for free. Keep this in reserve for the case where Hono's type surface proves insufficient.

## Decision

**Adopt option B.**

### Load-bearing commitments

1. **Hono is the trunk.** All middleware — Better Auth resolution to `Principal`, tenant scope into `AsyncLocalStorage`, rate limiting, capability dispatch, audit write, OTel span — mounts on the single Hono app exported from `packages/api-server/`. No surface runs the dispatcher outside this chain.
2. **Typed RPC is the consumer contract.** Every surface consumes the app through `hc<AppType>`. The transport differs:
   - **Server-side (Server Actions, RSC):** `hc('http://internal', { fetch: app.request.bind(app) })` via a thin `@editorzero/api-client` wrapper that forwards `cookie` / `authorization` from `next/headers`. No TCP hop.
   - **Client-side (CLI, remote MCP):** `hc<AppType>(baseUrl)` over real HTTP with bearer / API-key auth.
3. **MCP = Streamable HTTP only.** `@hono/mcp`'s `StreamableHTTPTransport` mounted at `app.all('/mcp', ...)` in the same Hono app, preceded by `@better-auth/mcp`'s `mcpAuthHono` middleware. Stdio transport is **dropped**. Remote clients traverse OAuth 2.1 + DCR + PKCE S256 + RFC 8707 audience as today (ADR 0009).
4. **CLI framework = `citty`.** `bun build --compile` per target tuple. Subcommand tree generated from the capability registry; one subcommand per `(capability × surface-compatible)` entry.
5. **CLI output behaviour governed by AXI** (Agent eXperience Interface — https://github.com/kunchenguid/axi). Committed agent-facing invariants:
   - **Errors on stdout** (not stderr) in a structured envelope with typed `code` matching the registry's capability-error union + actionable `help` suggestion. Stderr reserved for debug / diagnostic output only. This contradicts clig.dev; AXI wins for agent consumption.
   - **Minimal default list schemas** (3–4 fields: id, title, status / equivalent). `--fields` extends. Long text fields are truncated with a size indicator and a `--full` hint. Registry's list capabilities declare their default minimal projection.
   - **Pre-computed aggregates.** List outputs carry `count: N of M total`; detail views carry cheap derived fields (e.g. `comments: 7`) where the backend can supply them without a second query.
   - **Idempotent mutations exit 0** when the desired state already matches. "Close already-closed doc" is a no-op, not an error. Dispatcher and registry cooperate on this: capability `category` includes `idempotent: true` where applicable.
   - **No interactive prompts.** Every operation is completable with flags. Missing required flags fail fast with the flag name and a usage snippet on stdout. The device-auth flow is the one exception and prints URL + code to both stdout and `$XDG_RUNTIME_DIR/editorzero/device.json` so agent harnesses can scrape.
   - **Content first.** `editorzero` with no args prints the ambient dashboard (current workspace, pending @-mentions, doc-list head) — not help text.
   - **Session-hook self-install** for Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`). Hook command uses the absolute path of the current executable (`process.execPath` in a `bun build --compile` binary); repeated installs with the same path are silent no-ops; path repair on every invocation (self-heal after reinstall / relocation). `SessionStart` hook emits a compact dashboard of workspace state so agents orient without an explicit call.
6. **Agent-mode stdout format: deferred to eval.** AXI recommends TOON (https://toonformat.dev/) for ~40% token savings over JSON; we do not commit to that today. Before the CLI slice lands (P3.5 or later), an **eval harness** compares candidate formats on **both** axes:
   - **Token cost** — tokens emitted per representative agent workflow (list docs → read doc → update block → search).
   - **Agent task-completion success rate** — measured across a pinned set of LLM agents (Claude Sonnet-class + Haiku-class minimum) executing a fixed task suite through the CLI. Format wins only if it does not regress success vs JSON baseline.
   - Candidates to evaluate: TOON, JSON, JSONL, YAML-compact. Interim default during development: **JSON on stdout** (`--json` is a no-op in agent mode, `--pretty` reformats for TTY). Final choice committed in a small follow-up ADR or an amendment here once evals run.
   - Until the eval runs, all AXI commitments that reference TOON are satisfied by JSON output shaped to AXI's schema conventions (minimal fields, stdout errors, aggregates, help suggestions). The format is a pluggable serializer at the CLI output boundary; switching it is a one-file change.
5. **The capability registry generates every surface adapter.**
   - Hono routes via `@hono/zod-openapi` (preserves types for `hc<AppType>`).
   - MCP tools via the 1.x SDK's `server.tool()` registration loop.
   - CLI subcommands via citty `defineCommand` loop.
   - OpenAPI spec + `AppType` export for `hc` consumers.
   - No hand-written adapter glue. Contract tests (arch §5.5) backstop parity.

### Mechanics

- **`packages/api-server`** owns the Hono app + middleware chain + route generation from the registry. Exports `app` and `AppType`.
- **`packages/api-client`** owns the two typed-RPC builders:
  - `createServerClient()` → `hc` bound to `app.request` + `next/headers` forwarding. Used by Server Actions and RSC.
  - `createHttpClient({ baseUrl, auth })` → `hc` bound to `fetch`. Used by CLI and any external consumer.
- **`packages/mcp-server`** consumes the capability registry + `@hono/mcp` + `@modelcontextprotocol/sdk` 1.x. The MCP server is instantiated once per Hono app and mounted at `/mcp`.
- **`apps/cli`** is a thin `citty` binary. Reads `~/.editorzero/credentials`, constructs `createHttpClient`, maps subcommand args to capability input via zod.

## Consequences

- **Invariant 5 is enforced by construction.** The only way to invoke a capability is through the Hono middleware chain. Missing the permission check requires deleting it from the middleware — a visible, load-bearing edit.
- **Invariant 4 (parity) is free.** The registry is the spine; every surface is generated from it; the contract-tests matrix checks that no (capability × surface) cell was silently skipped.
- **One auth story.** Browsers send cookies, CLI sends API keys, agents send agent tokens, remote MCP clients send OAuth bearers. All go through the same Better Auth plugins, all resolve to the same `Principal` shape, in the same middleware. No surface special-cases authorization.
- **Drift prevention.** If the dispatcher interface changes, every surface recompiles; adding a capability means one registry entry and regenerated adapters.
- **Stdio MCP is gone.** Local-subprocess MCP clients must hit the Streamable HTTP endpoint (likely `http://localhost:3000/mcp` for self-hosted dev). This is a minor DX loss for air-gapped agents and a large architectural simplification.
- **Binary size.** CLI ships ~60MB (citty, near-zero deps) vs oclif's ~90MB. Distribution via `bun build --compile` matrix stays unchanged.
- **New packages.** `packages/api-server`, `packages/api-client`, `packages/mcp-server`, `apps/cli` are added to the monorepo scaffold (arch.md §14 Repository layout already slots for api-server + mcp-server; api-client is new).
- **Gotcha carried forward.** Next middleware runs on the Next request; Hono middleware runs on the synthesized Request. Any header set by Next middleware that Hono middleware needs must be forwarded explicitly by `createServerClient`. `@editorzero/api-client` owns that list; it is a capped allowlist, not a `...req.headers` dump (tenanting + audit integrity depends on not accepting spoofed headers).

## Cross-references and supersession

- **Refines ADR 0009 (MCP SDK).** Drops stdio transport; names `@hono/mcp` as the Hono integration middleware; records `xmcp` and `FastMCP TS` as evaluated-and-rejected. ADR 0009 decision section is updated in the same commit with a pointer here.
- **Refines ADR 0012 (Deploy artifact).** Names `citty` as the CLI framework; records `commander` / `oclif` / `clipanion` as evaluated-and-rejected; adopts AXI as the agent-output contract (TOON deferred to eval); commits to session-hook self-install for Claude Code + Codex.
- **Binds architecture.md §5.1–§5.4.** The agent implementing API / CLI / MCP / Web UI slices in P3.5 reads this ADR before editing those sections. Pointer added at the top of §5.
- **Binds AGENTS.md invariant 4 + 5.** Makes the "parity is enforced, not aspired to" claim mechanically true via registry-driven generation on a single trunk.

## Revisit triggers

- **Air-gapped agent use case appears** with hard "no HTTP" constraint → reintroduce stdio with a thin local-auth shim that resolves to the same `Principal`. Parity must be preserved — the stdio server would still consume the same registry.
- **`@hono/mcp` goes unmaintained** (it lives outside Hono core; single maintainer risk) → swap to the official `@modelcontextprotocol/hono` when v2 goes GA. Interface is essentially the same.
- **Hono 5 changes `app.request()` semantics** in a way that breaks in-process middleware coverage → re-evaluate trunk pattern; fall back to option C (transport-agnostic SDK).
- **citty stalls at pre-1.0 for 6+ months** without further releases → evaluate migration to commander. Interface is shallow; migration is a codemod over `defineCommand`.
- **AXI spec changes materially** (new required fields, breaking hook-install convention) → rev the CLI output layer accordingly. Current commitment is to AXI as of 2026-04-18.
- **Agent-mode stdout-format eval completes** → commit to TOON, JSON, or alternative via a small follow-up ADR / amendment. Until then, JSON is the interim default.
- **TOON spec or tooling evolves meaningfully before the CLI slice lands** (stable TS serializer, spec hits 1.0, benchmarks published) → incorporate into the eval harness as a higher-prior candidate.
- **MCP spec adopts a transport `@hono/mcp` does not implement** → hand-roll a transport adapter against the SDK's transport interface; it is ~200 LOC.
- **Contract test matrix flags a case where registry generation is insufficient** (e.g. a capability with surface-specific input shape) → revisit option C.

## Sources

- Hono RPC: https://hono.dev/docs/guides/rpc
- Hono testing helpers (`testClient`): https://hono.dev/docs/helpers/testing
- Hono `app.request()`: https://hono.dev/docs/api/hono#request
- `@hono/mcp` middleware: https://github.com/honojs/middleware/tree/main/packages/mcp
- `@modelcontextprotocol/sdk` TypeScript: https://github.com/modelcontextprotocol/typescript-sdk
- xmcp (rejected): https://xmcp.dev/
- FastMCP TS (rejected): https://github.com/punkpeye/fastmcp
- clig.dev — Command Line Interface Guidelines: https://clig.dev/
- **AXI — Agent eXperience Interface (governs agent-facing CLI behaviour):** https://github.com/kunchenguid/axi
- **TOON — Token-Oriented Object Notation (candidate agent-mode format, pending eval):** https://toonformat.dev/ — spec: https://toonformat.dev/reference/spec.html
- citty: https://github.com/unjs/citty
- Bun `--compile`: https://bun.com/docs/bundler/executables
- NO_COLOR: https://no-color.org/
- XDG base directories: https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
