# ADR 0006 — Real-time transport: Hocuspocus embedded

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Need server-side Yjs sync with auth hooks, durable persistence, awareness/presence, and first-class non-browser client support. The red-team flagged two issues with the original y-sweet sidecar plan: (1) the durability boundary between y-sweet and our app was not specified and risks at-most-once semantics under crash (#4); (2) mutations arriving via API/CLI/MCP must flow through the same CRDT the browser uses, or we get dual-source-of-truth divergence (#21). Both are resolved by folding the sync server into the app process.

## Options considered
- **Hocuspocus embedded** (MIT, Node) — rich server-side extension API: `onAuthenticate`, `onLoadDocument`, `onChange`, `onStoreDocument`. Pluggable persistence. Embeds directly into our Hono app — one process, one language, one write path. Durability is ours: we persist to `doc_updates` synchronously in `onChange` before `onStoreDocument` lets the ack propagate.
- **y-sweet sidecar** (MIT, Rust) — strong standalone deploy story, but on a Node backend (ADR 0002) the separate-process advantage is weaker and the durability/write-path specification becomes harder. Red-team findings #4 and #21.
- **y-websocket** — reference server, doesn't scale.
- **PartyKit** — Cloudflare-tied; breaks self-host.
- **Liveblocks OSS** — AGPL'd Feb 2026 but self-host "not quite available yet."
- **Roll our own** — 6–12 engineer-months; not needed given Hocuspocus.

## Decision
**Hocuspocus, embedded in the same Node process as the Hono app.**

**Durability boundary (explicit per red-team #4):**
1. Client sends Yjs update over WebSocket.
2. Hocuspocus receives; our `onAuthenticate` has already bound the WebSocket to a `Principal` (ADR 0016).
3. `onChange` fires — we enforce resource limits (ADR 0003 §resource-limits), call into the capability layer (ADR 0015) for permission, write the raw update to `doc_updates` in a DB transaction, emit audit event, then return.
4. Only after `onChange` returns does Hocuspocus ack the client and broadcast to other subscribers.
5. `onStoreDocument` periodically writes a new `doc_snapshot` (snapshot + compaction, ADR 0007 §compaction).

This means **every byte of every client's accepted update is durable on disk before the client sees the ack**. Crash recovery loads the latest snapshot + replays `doc_updates` since.

**Unified write path (red-team #21, see ADR 0018):** API, CLI, and MCP mutations construct synthetic Yjs updates against a server-side `Y.Doc` and apply them through the same Hocuspocus code path. There is one and only one write path into a document.

## Consequences
- Deploy graph drops one binary (no y-sweet sidecar). One process to run, monitor, observe.
- Durability semantics are explicit and testable: property test = "for any accepted update, reload-from-disk state includes it."
- Node is now in the real-time hot path — benchmark early (Phase 3 load test) at 20 concurrent editors × 500 ops/sec. Hocuspocus has production references at GitHub, LinkedIn, JupyterLab via `y-prosemirror`; the scale envelope is known.
- Authentication integrates natively with Better Auth session tokens (ADR 0010) and agent tokens — same session, same principal.
- Horizontal scale: Hocuspocus supports Redis-backed fan-out for multi-instance deployments; SQLite-mode single-instance is the default.
- Backend inspects doc state via native Yjs — Markdown export, search indexing, audit all in-process, no cross-runtime glue.

## Revisit triggers
- The Node real-time hot path hits a scale ceiling horizontal fan-out cannot resolve; introduce a Rust sync-server sidecar for the transport layer while keeping app-server durability boundary intact.
- Hocuspocus maintainership stalls.
- A required feature only y-sweet ships (e.g., a specific S3-native persistence semantic).
