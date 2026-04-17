# ADR 0018 — Unified write path: all mutations flow through the CRDT

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Red-team (#21) called this "the single most important architectural decision in the whole stack." The question: when an AI agent updates a doc via the MCP `doc_update` tool while a human edits the same doc in the browser via Hocuspocus, what is the write path for the agent?

- If the agent's write goes through the CRDT (as a synthetic Yjs client), browser updates and agent updates merge deterministically via Yjs's conflict resolution.
- If the agent's write goes around the CRDT (directly to the DB or to the Markdown AST), we have two sources of truth and divergence within the first week.

The decision was left implicit in the original ADRs 0003/0006. Making it explicit.

## Decision

**Every mutation — from any surface — flows through the CRDT.**

### The write path
```
  Request (API / CLI / MCP / Web UI Server Action)
     │
     ▼
  Capability dispatcher (ADR 0015)  ──►  permission + rate-limit + scope checks
     │
     ▼
  Capability handler constructs a Yjs update
  against an in-memory Y.Doc for the target document
     │
     ▼
  Update submitted to Hocuspocus (ADR 0006)  ◄── same path browser clients use
     │
     ▼
  Hocuspocus onChange:
     • enforce resource limits (ADR 0003)
     • write raw update to doc_updates in a DB tx
     • emit audit event
     │
     ▼
  Broadcast to subscribed clients (browsers AND the handler's "waiter")
     │
     ▼
  Capability handler returns post-apply state to the caller
```

### What capability handlers look like

For `doc.update(workspace_id, doc_id, blocks)`:
1. Load the current `Y.Doc` for `doc_id` (from Hocuspocus's in-memory map, or from `doc_snapshots` + `doc_updates` if not loaded).
2. Compute the minimal Yjs delta that turns the current state into the caller's requested state. Use `y-protocols` to construct the update.
3. Submit the update to Hocuspocus as if the handler were a synthetic Yjs client tied to the calling principal.
4. Wait for the `onChange` callback to confirm durable persistence.
5. Return the resulting doc view (projected from the updated `Y.Doc` into the caller's requested shape).

### What happens on conflict

Two browsers editing the same block simultaneously, or a browser + an agent editing simultaneously, both go through Hocuspocus. Yjs converges them deterministically per ADR 0003 invariant #2. The "latest-write" doesn't exist; both updates apply, and the resulting state is merged by the CRDT.

For semantic conflicts (e.g., agent wants to delete block X while human inserts block X+1 that references X), we ship the raw CRDT convergence — users see the merged state; if that state is semantically broken, a follow-up edit fixes it. Property tests (ADR 0013) verify convergence on fuzzed concurrent edit sequences.

### What this rules out

- **No direct DB writes** to `blocks`, `docs.content`, or any field that mirrors CRDT state. These fields are either removed from the schema or are projected-read-only (materialized from the latest snapshot, rebuilt by a job).
- **No "fast path"** for API bulk updates that bypasses the CRDT. Bulk updates go through the CRDT in batches; we optimize Yjs batch-update construction, not bypass it.
- **No surface-specific mutation logic.** Capabilities construct CRDT updates; that's the only mutation primitive the system exposes.

### Read path

Reads project from the CRDT to a stable representation (Markdown AST, block list, rendered HTML) via a pure function. Projections are cached; cache is invalidated on `onChange` (ADR 0006). Reads never touch the write path — a stale-ish read is cheaper than a write-through check.

## Consequences
- **The four-surface parity invariant holds for mutations by construction.** Every surface produces the same CRDT updates against the same document; there is nothing else to diverge on.
- **Conflict resolution is free** — Yjs handles it. Concurrent edits from any combination of principals converge.
- **Performance:** the capability dispatcher is in the hot path for every write. Benchmark at Phase 3. If the synthetic-client overhead is high, optimize by keeping hot docs' `Y.Doc`s in-memory across handler invocations (Hocuspocus already does this).
- **Complexity:** capability handlers construct Yjs deltas, which is more verbose than "write JSON to the DB." Accept the verbosity for the invariant.
- **Hot-path hazard:** if the capability handler fails after submitting to Hocuspocus but before the client sees a response, the write is still persisted. Handlers must therefore construct the return value from a post-apply read, not from the input — idempotent-by-construction.

## Revisit triggers
- The synthetic-client overhead on bulk-import workloads is unacceptable and a batched direct-CRDT-insert path is demonstrably safe.
- A capability emerges that cannot be expressed as a CRDT delta (unlikely).
- Yjs conflict resolution produces a semantically broken state a property test catches; we then specify the semantic-layer resolution the capability applies before submitting.
