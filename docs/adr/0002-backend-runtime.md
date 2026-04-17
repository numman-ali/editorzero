# ADR 0002 — Backend runtime: Node 22 LTS with Hono

**Status:** Accepted (post-refresh)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

## Context
Backend serves the HTTP API, the Hocuspocus WebSocket sync path (ADR 0006), search, audit, notifications, MCP server, and background jobs. Deploy target: `docker compose up` for non-expert self-hosters. Ecosystem coupling matters — Yjs, BlockNote, React, Better Auth, the TypeScript MCP SDK are all TS-native; a non-TS backend creates impedance at the most important seams.

The refreshed research (April 2026) specifically re-examined Bun, now at 1.3.12 with Anthropic acquisition complete.

## Options considered
- **Node 22 LTS** — Active LTS ended Oct 21 2025; now Maintenance LTS, EOL **April 30 2027** (corrected from earlier date). Enterprise-blessed on RHEL/Debian LTS. Well-characterized under memory pressure and long-lived WebSocket sessions. Node 24 enters Active LTS Oct 2026 (EOL Apr 2028) — evaluate in Q3 2026.
- **Bun 1.3.12** (current) — WebSocket perf is genuinely strong (~1.2M concurrent vs Node's ~680K; −40% per-socket memory). Polyfill gaps partially closed since 1.2 but **still missing**: `node:worker_threads` (`resourceLimits`, `moveMessagePortToContext`, `stdio`), `node:crypto` FIPS mode, secure heap. **No formal LTS policy.** Open JSC-GC issue (#29302) under Next.js SSR on 1.3.11–1.3.13. Trigger.dev's Firebun post-mortem documented HTTP-path memory leaks under long-poll workloads patched only in late March 2026. `onnxruntime-node` (our embedding path) has no first-class Bun path; WASM fallback costs perf.
- **Go / Rust / Elixir** — considered in v1, same conclusion: CRDT+editor+auth+MCP ecosystem gravity outweighs single-binary gains.

## Decision
**Node 22 LTS in production.** TypeScript. **Hono** framework. **pnpm** monorepo shared with the React frontend.

**Bun used opportunistically**, not as the production runtime:
- `bun build --compile` for the `editorzero` **CLI** binary distribution (cross-compiled Linux/macOS/Windows, amd64/arm64). CLI is short-lived and stateless — plays to Bun's strengths; none of the long-lived hot-path risks apply.
- `bun` as test runner and monorepo task runner in CI where cold-start time matters.

## Consequences
- Deploy is Docker-first (ADR 0012). CLI ships as single cross-compiled binaries courtesy of `bun build --compile` — partial recovery of the single-binary aesthetic for users who interact via CLI.
- Node 22 LTS + TS + native Yjs + BlockNote + Better Auth + MCP SDK all in one language; no cross-runtime glue at the most important seams.
- Node dep surface requires aggressive advisory tracking (Dependabot, Socket, `npm audit` in CI).
- Hocuspocus (ADR 0006) is a Node library — embeds directly, unified write path by construction.
- Backend and frontend share a capability registry (ADR 0015) and TypeScript types.

## Revisit triggers
- Bun ships a formal LTS policy, issue #29302 closes on a stable tag, and `onnxruntime-node` (or an equivalent first-class embedding runtime) lands.
- Node 22 reaches EOL (Apr 30 2027); migrate to Node 24 LTS.
- A Node real-time hot-path workload hits a ceiling no horizontal scale + no targeted native sidecar can resolve.
