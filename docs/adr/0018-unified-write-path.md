# ADR 0018 — Unified write path: all mutations flow through the CRDT via Hocuspocus direct connection + BlockNote editor

**Status:** Accepted (post-refresh, API prose corrected 2026-04-17 after BlockNote research pass; updated 2026-04-17 to reflect pass-3 disposition)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

> **Updated 2026-04-17 to reflect pass-3 disposition (F76).** Write-path ownership sharpened to match architecture.md §6.1–6.3 exactly: the **dispatcher** owns the single write-path DB tx; **Hocuspocus** provides the per-doc serializer and the DB-tx hook (not audit ownership). The tx commits `doc_updates + outbox(doc.updated) + audit_events + outbox(audit.appended)` together (F31). `onChange` is no longer described as independently writing audit; audit is a dispatcher responsibility inside the same tx.

## Context
v1 decided every mutation from every surface goes through the CRDT via Hocuspocus. The April-2026 BlockNote research pass resolved the implementation primitive: Hocuspocus's `openDirectConnection(docId).transact(ydoc => …)` loads the live `Y.Doc`, and inside that callback `BlockNoteEditor.create({ collaboration: { fragment } })` binds a headless block editor to the doc's `Y.XmlFragment`. Typed block ops then produce ProseMirror transactions → Yjs updates through the same pipeline browser clients use.

Note: `@blocknote/server-util`'s `ServerBlockNoteEditor` is a **conversion surface** (blocks ↔ HTML / Markdown / Y.Doc) — it does not expose `transact/insertBlocks/updateBlock/removeBlocks`. Those methods live on `BlockNoteEditor` (accessible via `ServerBlockNoteEditor.editor` or constructed directly). The write path uses `BlockNoteEditor` directly.

## Decision

**Every mutation — API, CLI, MCP, Web UI — flows through the CRDT as a headless `BlockNoteEditor` bound to the live `Y.Doc` via Hocuspocus `openDirectConnection`.**

### The write path

```
  Request from any surface
     │
     ▼
  Capability dispatcher (ADR 0015)
     │   permission + rate-limit + scope checks; owns the write-path DB tx
     ▼
  Capability handler calls ctx.transact(doc_id, fn):
     1. hocuspocus.openDirectConnection(doc_id, ctx) acquires the
        live Y.Doc (hydrating from doc_snapshots + doc_updates if
        not resident). Per-doc serializer queues this closure.
     2. direct.transact((ydoc) => {
          const fragment = ydoc.getXmlFragment("prosemirror");
          const editor = BlockNoteEditor.create({
            collaboration: { fragment, user: principalAsYUser }
          });
          editor.transact(() => {
            editor.insertBlocks(...) / updateBlock(...) / removeBlocks(...)
          }); // collapses to one ProseMirror tx → one Yjs update u
        })
     3. Resource limits enforced on u (ADR 0003).
     4. Dispatcher captures post-state from the editor and computes
        capability.audit.effectOnAllow(input, postState).
     ▼
  Dispatcher-owned write-path DB tx (runs inside Hocuspocus's DB-tx hook;
  single commit boundary — F31):
     BEGIN DB tx:
       allocate seq via doc_counters row-lock (architecture.md §6.4)
       INSERT doc_updates(seq, blob, principal, session, …)
       INSERT outbox("doc.updated", doc_id, seq, …)
       INSERT audit_events(capability_id, outcome="allow", effect, …)
       INSERT outbox("audit.appended", audit_id, …)
     COMMIT
     ▼
  Hocuspocus broadcasts u to subscribers after the dispatcher tx commits.
  onStoreDocument (debounced, non-concurrent per doc):
     • consolidated snapshot written to doc_snapshots (ADR 0007 §compaction)
     • does NOT write audit; does NOT own the write-path tx
     ▼
  Capability handler reads post-apply state from the Y.Doc
  and returns to the caller
```

### Why this composition

- Hocuspocus `openDirectConnection(docId).transact(ydoc => …)` is the canonical server-side write into a live Y.Doc. MIT, part of `@hocuspocus/server`. It serializes against other direct writers and resident browser sessions, and routes through the same `onChange` pipeline — the invariant "one write path" holds because there **is** only one path.
- `BlockNoteEditor.create({ collaboration: { fragment, user } })` inside that callback gives the capability handler a **headless block editor** against the live `Y.XmlFragment`. It exposes `insertBlocks(blocks, referenceBlock, placement)`, `updateBlock(blockOrId, update)`, `removeBlocks(blocks)`, `replaceBlocks(remove, insert)` — a 1:1 match to agent intent expressed via MCP `doc.update`.
- `editor.transact(fn)` collapses multi-op work into one ProseMirror transaction → one Yjs update → one `onChange` event → one durable `doc_updates` row. The dispatcher commits `doc_updates + outbox(doc.updated) + audit_events + outbox(audit.appended)` in a single DB transaction inside Hocuspocus's DB-tx hook (F31 / architecture.md §6.1–6.3). Atomicity is a property of the composition, not of any single layer.
- Block IDs are native (ADR 0004). No directive-attribute ID bookkeeping.
- `@blocknote/server-util`'s `ServerBlockNoteEditor` is used for **conversions** (blocks ↔ HTML/Markdown/Y.Doc for initial import, projections, agent readbacks) — not for writes. Its `blocksToYDoc` is explicitly "not a rehydration path" per BlockNote docs; the correct pattern is **always** "direct-connection to live Y.Doc → apply transaction → dispatcher writes audit → pipeline broadcasts." Documented in AGENTS.md so future contributors don't regress.

### Mutation from Markdown input (agent authoring)

An MCP tool call like `doc.update_from_markdown(md)` goes through:
1. Parse `md` → mdast tree (remark-parse, pinned version).
2. Convert mdast → BlockNote block array via our per-block-type `fromMarkdown` functions (ADR 0013 v2 fidelity tiers).
3. Diff against current block array (`reconcileBlocks(current, incoming)` → list of `insert/update/remove` ops) using the reconcile contract in architecture.md §6.6 (state-vector check + `mode=reconcile|replace` + `preserve_orphans`).
4. Apply the ops via `editor.transact` inside the same `openDirectConnection.transact` callback.

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

## Open verification (before ADR 0018 locks in Phase 3)
- **Smoke integration test:** `BlockNoteEditor.create({ collaboration: { fragment } })` inside `openDirectConnection.transact()` under concurrent human + agent edits; assert no cursor-awareness leakage, no orphan writes, correct broadcast to browser sessions.
- **Bulk-import baseline:** construct-editor-per-op vs construct-editor-once-per-transact overhead at 50k blocks; numbers inform whether bulk import needs an alternative batching strategy.

## Revisit triggers
- Synthetic-client overhead on bulk-import workloads (e.g., importing a 50k-block Notion export) is unacceptable and a batched direct-CRDT insert path is demonstrably safe.
- A capability emerges that cannot be expressed as a block-level op (unlikely given BlockNote's schema).
- `BlockNoteEditor` API breaks in a version we cannot absorb, or `@blocknote/core` stalls (DINUM/ZenDiS funding lapses; release cadence > 6 months).
