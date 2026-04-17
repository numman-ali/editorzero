# ADR 0006 — Real-time transport: Hocuspocus embedded

**Status:** Accepted (post-refresh)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

## Context
Server-side Yjs sync with auth hooks, durable persistence, awareness/presence, first-class non-browser client support. Original v1 decision (Hocuspocus over y-sweet) stands. Refresh surfaced Hocuspocus 3.4.x behavior changes worth encoding in the durability spec.

## Decision
**Hocuspocus 3.4.x**, embedded in the same Node process as the Hono app. Current as of April 2026: `@hocuspocus/server` **v3.4.4** (Jan 25 2026).

### Durability boundary (explicit)

```
  Request (API / CLI / MCP / Web UI Server Action)
     │
     ▼
  Capability dispatcher (ADR 0015)  ──►  permission + rate-limit + scope checks
     │
     ▼
  Capability handler constructs a Yjs update via
  ServerBlockNoteEditor (ADR 0004) bound to the live Y.Doc
     │
     ▼
  Update submitted to Hocuspocus  ◄── same path browser clients use
     │
     ▼
  Hocuspocus onChange (sync handler):
     • enforce resource limits (ADR 0003)
     • write raw update to doc_updates in a DB tx
     • emit audit event
     │
     ▼
  Broadcast to subscribed clients (browsers AND the handler's waiter)
     │
     ▼
  onStoreDocument (debounced, non-concurrent):
     • write consolidated snapshot to doc_snapshots (ADR 0007 §compaction)
     • compaction trigger if applicable
```

**Every byte of every accepted update is durable on disk before the client sees the ack.** Crash recovery loads the latest snapshot + replays `doc_updates` since.

### 3.4.x behavior notes (refresh findings)
- `onStoreDocument` is now **non-concurrent** per doc — multiple triggers serialize. Handler must be idempotent (insert snapshot WHERE `seq > latest_snapshot_seq`; no-op if nothing new).
- `beforeSync` is **no longer awaited** — do not rely on it for pre-sync validation; enforce resource limits in `onChange`.
- `onTokenSync` hook (new in 3.3.0) available for token refresh during long-lived sessions — use for agent token rotation.
- v3.2.6 rewrote Redis unloading logic — the scale-out model.

### Horizontal scale
Redis-backed fan-out using the **worker-nodes + single-manager topology** (per Hocuspocus 3.x Redis scaling docs) — not symmetrical. Single-node SQLite-mode does not need Redis; Postgres-mode HA deploys do.

### Unified write path (see ADR 0018)
API, CLI, MCP, and Web UI mutations all flow through a `ServerBlockNoteEditor.transact()` that emits a Yjs update applied through Hocuspocus's standard pipeline. One write path for every surface.

## Consequences
- One process to run, monitor, observe.
- Durability semantics explicit and testable: property test = "for any accepted update, reload-from-disk state includes it."
- Node is in the real-time hot path — Phase 3 load test at 20 concurrent editors × 500 ops/sec.
- Authentication integrates natively with Better Auth session tokens + `@better-auth/agent-auth` tokens (ADR 0010, ADR 0016) — same session, same principal.
- Backend inspects doc state via native Yjs — Markdown export (ADR 0013 v2 per-block fidelity), search indexing, audit, git-mirror projection (ADR 0020) all in-process.

## Revisit triggers
- Node hot path hits a scale ceiling horizontal fan-out cannot resolve; introduce a Rust sync-server sidecar (e.g., y-sweet) for transport while keeping app-server durability boundary intact.
- Hocuspocus maintainership stalls (currently ueberdosis-backed; healthy).
- Redis worker-manager topology proves operationally painful and a leaderless alternative ships.
