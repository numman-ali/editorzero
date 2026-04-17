# ADR 0018 — Unified write path: all mutations flow through the CRDT via BlockNote's ServerBlockNoteEditor

**Status:** Accepted (post-refresh)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

## Context
v1 decided every mutation from every surface goes through the CRDT via Hocuspocus. The refresh surfaced `@blocknote/server-util`'s `ServerBlockNoteEditor` as a ready-made implementation of the "synthetic client" that constructs Yjs updates from typed block operations. This ADR tightens the implementation story.

## Decision

**Every mutation — API, CLI, MCP, Web UI — flows through the CRDT using `ServerBlockNoteEditor` as the synthetic client.**

### The write path

```
  Request from any surface
     │
     ▼
  Capability dispatcher (ADR 0015)
     │   permission + rate-limit + scope checks
     ▼
  Capability handler:
     1. Load live Y.Doc from Hocuspocus for target doc (or load from
        doc_snapshots + doc_updates if not resident)
     2. Construct ServerBlockNoteEditor bound to the Y.XmlFragment
     3. editor.transact(() => {
          editor.insertBlocks(...) / updateBlock(...) / removeBlocks(...)
        })   // all mutations collapse to one undo step
     4. y-prosemirror produces the Yjs update; the update is applied
        through the same Hocuspocus pipeline browser clients use
     ▼
  Hocuspocus onChange:
     • enforce resource limits (ADR 0003)
     • durable write to doc_updates in a DB tx
     • emit audit event (ADR 0016)
     ▼
  onStoreDocument (debounced, non-concurrent in 3.4.x):
     • write consolidated snapshot when trigger fires (ADR 0007 §compaction)
     ▼
  Broadcast to subscribed clients (browsers AND the handler's waiter)
     ▼
  Capability handler reads post-apply state from the Y.Doc
  and returns to the caller
```

### Why `ServerBlockNoteEditor`

`@blocknote/server-util`'s `ServerBlockNoteEditor`:
- Gives the capability handler a **headless editor** bound to the live `Y.XmlFragment`.
- Exposes `insertBlocks(blocks, referenceBlock, placement)`, `updateBlock(blockOrId, update)`, `removeBlocks(blocks)`, and `replaceBlocks(blocksToRemove, blocksToInsert)` — a 1:1 match to agent intent expressed via MCP `doc.update`.
- `editor.transact(fn)` collapses multi-op work into one ProseMirror transaction → one Yjs update → one `onChange` event → one durable write → one audit row. Atomicity for free.
- Block IDs are native (ADR 0004). No directive-attribute ID bookkeeping.
- Does **not** rehydrate history from Markdown (`blocksToYDoc` is explicitly "not a rehydration path" per docs). The correct pattern is **always** "load live Y.Doc → apply transaction → save via the normal pipeline." Documented in AGENTS.md so future contributors don't regress.

### Mutation from Markdown input (agent authoring)

An MCP tool call like `doc.update_from_markdown(md)` goes through:
1. Parse `md` → mdast tree (remark-parse, pinned version).
2. Convert mdast → BlockNote block array via our per-block-type `fromMarkdown` functions (ADR 0013 v2 fidelity tiers).
3. Diff against current block array (`reconcileBlocks(current, incoming)` → list of `insert/update/remove` ops).
4. Apply the ops via `editor.transact`.

The diff step is important: we don't blow away the doc on every Markdown-in call — we compute minimal edits so concurrent human edits aren't clobbered.

### What this rules out
- No direct DB writes to `blocks` / `docs.content` / any field mirroring CRDT state. Mirror fields are projected-read-only, rebuilt from the latest snapshot by a job.
- No "fast path" bulk API that bypasses the CRDT. Bulk goes through `editor.transact` with a larger transaction.
- No surface-specific mutation logic. Capabilities construct block ops (or Markdown that gets parsed to block ops); that's it.

### Read path
Reads project from the Y.Doc to stable representations: block array, rendered Markdown (per ADR 0013 v2 fidelity tiers), rendered HTML. Projections are cached; cache invalidated on `onChange`. Reads never touch the write path.

## Conflict semantics
Two humans, a human + an agent, two agents — any mix, any surface — editing the same doc converge via Yjs. No semantic-layer reconciliation is imposed; if the merged state is semantically broken, a follow-up edit fixes it. Property tests (ADR 0013) verify convergence on fuzzed concurrent edit sequences.

## Consequences
- Four-surface parity for mutations **holds by construction**. Every surface produces Yjs updates against the same Y.Doc via the same editor primitive.
- Conflict resolution is Yjs's problem — no custom merge logic.
- Capability handlers are idempotent-by-construction: the return value is read from the post-apply Y.Doc, not inferred from the input. Safe under retry.
- Performance: capability dispatcher is in the hot path. Hot docs' Y.Docs stay resident via Hocuspocus's in-memory map. Benchmark in Phase 3 at 20 concurrent editors × 500 ops/sec.
- Complexity cost: capability handlers construct block ops / Markdown, not raw SQL. Accepted for the invariant.

## Revisit triggers
- Synthetic-client overhead on bulk-import workloads (e.g., importing a 50k-block Notion export) is unacceptable and a batched direct-CRDT insert path is demonstrably safe.
- A capability emerges that cannot be expressed as a block-level op (unlikely given BlockNote's schema).
- BlockNote's `ServerBlockNoteEditor` API breaks in a version we cannot absorb.
