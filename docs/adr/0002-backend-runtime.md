# ADR 0002 — Backend runtime: Node 22 LTS with Hono

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Backend serves the HTTP API, the Hocuspocus WebSocket sync path (ADR 0006), search, audit, notifications, MCP server, and background jobs. Deploy target: `docker compose up` for non-expert self-hosters. Ecosystem coupling matters — Yjs, Milkdown, React, Better Auth, the TypeScript MCP SDK are all TS-native; a non-TS backend creates impedance at the most important seams.

## Options considered
- **Node 22 LTS** — active LTS through Apr 2027, maintenance through Apr 2028. Mature, widely deployed, enterprise-blessed on RHEL/Debian LTS. Well-characterized under memory pressure and long-lived WebSocket sessions.
- **Bun 1.2+** — fast and ergonomic, but 1.2 still ships correctness gaps in `node:worker_threads`, `node:crypto` FIPS modes, TLS edge cases, and `node:http` streaming semantics. Self-hosters on RHEL/Debian LTS hit glibc/musl distribution friction. Aggressive upgrade cadence is a risk for a server runtime under customer-owned infrastructure.
- **Deno 2** — the compatibility surface with the Node ecosystem is better than in Deno 1 but still not as boring as Node. Not worth the novelty tax.
- **Go / Rust** — true single-binary deploy, but Yjs/Milkdown/Better Auth ecosystem coupling makes the backend-frontend seam much more expensive.
- **Elixir (Phoenix)** — unmatched real-time on the BEAM, but MCP SDK gap and SQLite second-classness.

## Decision
**Node 22 LTS**, TypeScript, **Hono** framework, **pnpm** monorepo shared with the React frontend.

The red-team flagged Bun as a blocker for a product whose differentiator is not runtime speed. Node 22 LTS is the boring correct answer; we get the TS ecosystem gains without taking on a young runtime in the production hot path. Bun is welcome at dev-time (tests, scripts) if individual contributors prefer it; it is not the production substrate.

## Consequences
- Deploy is Docker-first. **No single-binary stretch goal** — we are honest about the deploy model (see ADR 0012).
- TypeScript + native Yjs + Milkdown + Better Auth + MCP SDK all in one language; no cross-runtime glue at the most important seams.
- Node dep surface requires aggressive advisory tracking (Dependabot, Socket, `npm audit` in CI).
- Hocuspocus (the real-time transport, ADR 0006) is a Node library — embeds directly, unified write path by construction.
- Backend and frontend share a capability registry (see ADR 0015) and TypeScript types; contract tests can be generated, not hand-maintained.

## Revisit triggers
- A Node real-time workload hits a hot-path performance ceiling we cannot resolve with horizontal scale or a Rust sidecar for a specific subsystem.
- Node 22 LTS reaches end-of-maintenance without a clean LTS successor.
- Bun reaches boring-correct stability (several years of clean LTS equivalent) and the perf delta becomes user-visible.
