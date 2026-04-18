# ADR 0006 — Real-time transport: Hocuspocus embedded

**Status:** Accepted (post-refresh; updated 2026-04-17 to reflect pass-3 disposition)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

> **Updated 2026-04-17 to reflect pass-3 disposition (F76).** Ownership boundary between dispatcher and Hocuspocus rewritten to match architecture.md §6.1–6.3 exactly: the **dispatcher** owns the write-path DB tx (single commit boundary); **Hocuspocus** provides the per-doc serializer and the DB-tx hook, not audit ownership. `doc_updates`, `audit_events`, and both `outbox` rows (`doc.updated`, `audit.appended`) commit in a single DB transaction. Earlier wording that read like Hocuspocus's `onChange` wrote audit independently has been replaced.

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
  Capability handler calls ctx.transact(doc_id, fn):
     • Hocuspocus openDirectConnection(doc_id) acquires the live Y.Doc;
       per-doc serializer queues this closure
     • fn(editor) binds BlockNoteEditor.create({ collaboration: { fragment } })
       and runs editor.transact(...) → one Yjs update u
     • Resource limits enforced on u (ADR 0003)
     │
     ▼
  Dispatcher owns the write-path DB tx (single commit boundary):
     BEGIN DB tx (runs inside Hocuspocus's per-doc DB-tx hook):
       allocate seq via doc_counters row-lock (architecture.md §6.4)
       INSERT doc_updates(seq, blob, principal, session, …)
       INSERT outbox("doc.updated", doc_id, seq, …)
       INSERT audit_events(capability_id, outcome="allow", effect, …)
       INSERT outbox("audit.appended", audit_id, …)
     COMMIT
     │
     ▼
  Hocuspocus broadcasts u to subscribers after the dispatcher tx commits.
     │
     ▼
  onStoreDocument (debounced, non-concurrent per doc):
     • consolidated snapshot written to doc_snapshots (ADR 0007 §compaction)
     • does NOT write audit; does NOT own the write-path tx
```

**Every byte of every accepted update is durable on disk before the client sees the ack.** Crash recovery loads the latest snapshot + replays `doc_updates` since. `doc_updates` + `audit_events` + both `outbox` rows share a single commit boundary — there is no window in which one exists without the others (architecture.md §6.1–6.3, F31).

### 3.4.x behavior notes (refresh findings)
- `onStoreDocument` is now **non-concurrent** per doc — multiple triggers serialize. Handler must be idempotent (insert snapshot WHERE `seq > latest_snapshot_seq`; no-op if nothing new).
- `beforeSync` is **no longer awaited** — do not rely on it for pre-sync validation; enforce resource limits in `onChange`.
- `onTokenSync` hook (new in 3.3.0) available for token refresh during long-lived sessions — use for agent token rotation.
- v3.2.6 rewrote Redis unloading logic — the scale-out model.

### Horizontal scale
Redis-backed fan-out using the **worker-nodes + single-manager topology** (per Hocuspocus 3.x Redis scaling docs) — not symmetrical. Single-node SQLite-mode does not need Redis; Postgres-mode HA deploys do.

### Unified write path (see ADR 0018)
API, CLI, MCP, and Web UI mutations all flow through `ctx.transact(doc_id, fn)`, which opens a Hocuspocus direct connection, binds a `BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>` to the live `Y.XmlFragment`, and runs `editor.transact(...)` → one Yjs update → the same Hocuspocus pipeline browser clients use. `@blocknote/server-util`'s `ServerBlockNoteEditor` is a conversion surface only — **explicitly wrong to treat as a write primitive** — its `blocksToYDoc` is not a rehydration path (loses history) and it does not expose `transact/insertBlocks/updateBlock/removeBlocks`. See ADR 0018 for the full write path and AGENTS.md gotchas.

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
