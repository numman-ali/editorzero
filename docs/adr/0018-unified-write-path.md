# ADR 0018 — Unified write path for content mutations: through the CRDT via Hocuspocus direct connection + BlockNote editor

**Status:** Accepted (post-refresh, API prose corrected 2026-04-17 after BlockNote research pass; updated 2026-04-17 to reflect pass-3 disposition; per-op preconditions added 2026-04-18 per [ADR 0022](0022-agent-editing-constraints.md); **empirical verification for content mutations landed 2026-04-19, P3.6 closed for that scope**)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

> **Scope clarified 2026-04-19 (P3.6f).** "Content mutation" = any `category = "mutation"` capability that is *not* in `METADATA_ONLY_CAPABILITIES` (architecture.md §6.5; canonical list in `packages/scopes`). The CRDT-via-Hocuspocus pipeline below is the contract for **content mutations**. Metadata-only mutations — `block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.move`, `collection.*` — never call `ctx.transact`, never open a Hocuspocus direct connection, never write `doc_updates`; their **landed tuple today** is the capability's own relational metadata write(s) (e.g. `block.set_visibility` updates `blocks.visibility` + `docs.visibility_version`) **plus** `audit_events(allow)` **plus** `outbox(audit.appended)` inside the dispatcher's `withSystemTx`. The fuller tuple that also includes capability-specific handler-emitted `ctx.outbox(...)` rows (e.g. `doc.publish` enqueues `projection_blocks` per architecture.md §13.1 / §16.4) is still **planned**: no non-test dispatcher composition root exists in the tree yet, and every current `createDispatcher(...)` site is a test fixture passing `ctx.outbox(...)` as a no-op stub, so those rows are neither co-committed nor empirically verified yet. The planned `metadata-only-set.integration.ts` (architecture.md §17.1 row 7b — Phase 4) will assert the all-or-none commit of that fuller tuple after the wiring lands. The "Decision" and "Empirical verification" sections below apply to the content-mutation pipeline only.
>
> **Updated 2026-04-17 to reflect pass-3 disposition (F76).** Write-path ownership sharpened to match architecture.md §6.1–6.3 exactly: the **dispatcher** owns the single write-path DB tx; **Hocuspocus** provides the per-doc serializer and the DB-tx hook (not audit ownership). The tx commits `doc_updates + outbox(doc.updated) + audit_events + outbox(audit.appended)` together (F31). `onChange` is no longer described as independently writing audit; audit is a dispatcher responsibility inside the same tx.
>
> **[ADR 0022](0022-agent-editing-constraints.md), 2026-04-18:** adds an optional per-op `expect_prior_content_hash` check that runs inside the `ctx.transact` closure before op application; `StalePreconditionError` fails closed on mismatch. Does not change the write-path shape; the check is a pre-condition inside the same transact.

## Context
The v1 architecture decision is that every **content mutation** from every eventual surface adapter goes through the CRDT via Hocuspocus; metadata-only capabilities are the explicit carve-out in the scope note above. The April-2026 BlockNote research pass resolved the implementation primitive: Hocuspocus's `openDirectConnection(docId).transact(ydoc => …)` loads the live `Y.Doc`, and inside that callback `BlockNoteEditor.create({ collaboration: { fragment } })` binds a headless block editor to the doc's `Y.XmlFragment`. Typed block ops then produce ProseMirror transactions → Yjs updates through the same pipeline browser clients use.

Note: `@blocknote/server-util`'s `ServerBlockNoteEditor` is a **conversion surface** (blocks ↔ HTML / Markdown / Y.Doc) — it does not expose `transact/insertBlocks/updateBlock/removeBlocks`. Those methods live on `BlockNoteEditor` (accessible via `ServerBlockNoteEditor.editor` or constructed directly). The write path uses `BlockNoteEditor` directly.

## Decision

**Design contract:** every content mutation — once API / CLI / MCP / Web UI surface adapters exist — flows through the CRDT as a headless `BlockNoteEditor` bound to the live `Y.Doc` via Hocuspocus `openDirectConnection`. (As of P3.6, the landed/runtime evidence is the shared dispatcher + sync primitive, not the surface adapters themselves. Metadata-only mutations are excluded from this decision — see the scope callout above.)

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
  TODAY (P3.6-landed broadcast timing):
     • During the `direct.transact` callback, as the Yjs update `u`
       emits, Hocuspocus broadcasts it to subscribers immediately —
       before the dispatcher-owned SQL tx commits.
     • On dispatcher-tx rollback, durable SQL state rolls back; the resident
       Y.Doc is evicted via `BoundSyncService.rollback()` only when no other
       connection holds the doc resident. With a live WebSocket peer, the
       rolled-back delta persists in the resident Y.Doc and on that peer's
       local replica until reload (the `HocuspocusSync` class docstring in
       `packages/sync/src/hocuspocus.ts` and the `"rollback leaves the doc
       resident when a concurrent connection holds it"` regression test in
       `packages/sync/src/hocuspocus.integration.test.ts` document this).
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
  PLANNED (Phase 4):
     • Buffer the broadcast until SQL commit (broadcast-on-commit /
       rollback-safe client buffering). Once that lands, live WS peers
       observe the post-commit form instead of today's pre-commit broadcast.
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
- `editor.transact(fn)` collapses multi-op work into one ProseMirror transaction → one Yjs update → one `onChange` event → one durable `doc_updates` row. The dispatcher commits `doc_updates + outbox(doc.updated) + audit_events + outbox(audit.appended)` in a single DB transaction inside Hocuspocus's DB-tx hook (F31 / architecture.md §6.1–6.3). Atomicity is a property of the landed composition for the durable SQL tuple, not of any single layer; live-WS post-rollback cleanup still depends on the planned broadcast-on-commit path above.
- Block IDs are native (ADR 0004). No directive-attribute ID bookkeeping.
- `@blocknote/server-util`'s `ServerBlockNoteEditor` is used for **conversions** (blocks ↔ HTML/Markdown/Y.Doc for initial import, projections, agent readbacks) — not for writes. Its `blocksToYDoc` is explicitly "not a rehydration path" per BlockNote docs; the correct pattern is **always** "direct-connection to live Y.Doc → apply transaction → dispatcher writes audit → pipeline broadcasts immediately today, and post-commit once Phase 4's buffered-broadcast path lands." Documented in AGENTS.md so future contributors don't regress.

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

For **content mutations** (the scope of this ADR — see callout above):

- **Planned invariant — four-surface parity for content mutations.** Once the four surface adapters (API, CLI, MCP, web UI — package layout per [ADR 0021](0021-surface-transport-topology.md)) and the contract-test matrix are wired, those adapters will all produce Yjs updates against the same Y.Doc via the same editor primitive (`BlockNoteEditor.create({ collaboration: { fragment } }).transact` inside `openDirectConnection.transact`), and parity will be enforced by the matrix per architecture invariant 4. **Today's evidence covers the shared dispatcher + sync primitive only** (see § Empirical verification below — synthetic fixture capabilities through `runInWriteTx` + `HocuspocusSync.bind`); no surface adapter, parity harness, or `apps/` tree exists yet, so this is design intent, not runtime status. Phase 4 work.
- Conflict resolution is Yjs's problem — no custom merge logic.
- Capability handler **outputs** are post-state-derived: the return value is read from the post-apply Y.Doc, not inferred from the input, so a successful retry observes the same response as the first call. **Mutation idempotency itself is capability-specific, not pipeline-guaranteed.** Imperative editor ops (`insertBlocks` / `removeBlocks` / `replaceBlocks`) re-apply on retry unless the caller supplies a precondition or idempotency key. ADR 0022 introduces `expect_prior_content_hash` for `update`/`move`/`remove`/`set_visibility` ops as the precondition primitive — it is *required* on every agent-issued op and *omitted* by the human BlockNote UI (which has the live CRDT). Before treating any mutation as safe to retry, callers must use that precondition or a capability-declared idempotency contract; at-least-once delivery (architecture.md §6.3) leans on this and inherits the same caveat.
- Performance: capability dispatcher is in the hot path. Hot docs' Y.Docs stay resident via Hocuspocus's in-memory map. Benchmark in Phase 3 at 20 concurrent editors × 500 ops/sec.
- Complexity cost: content-mutation capability handlers construct block ops / Markdown, not raw SQL. Accepted for the invariant.

For **metadata-only mutations** (excluded from this ADR's pipeline — see scope callout):

- **Planned invariant — four-surface parity for metadata-only mutations** is intended to ride the dispatcher's per-surface adapter generation, not the CRDT pipeline; the metadata-only set never produces Yjs updates. As with the content-mutation bullet above, this is contingent on the adapter packages and contract-test matrix landing; today's evidence covers the dispatcher tx primitive only (and even there, the capability-specific `ctx.outbox(...)` portion is unwired — see next bullet).
- Atomicity rests on the dispatcher's `withSystemTx` alone, but only part of the metadata-only tuple is landed today: the capability's relational metadata write(s) plus `audit_events(allow)` plus `outbox(audit.appended)` commit together; there is no `doc_updates` pair to coordinate with. **Implementation debt + verification debt:** `ctx.outbox(...)` is plumbed at the type level but no non-test dispatcher composition root exists yet — every current `createDispatcher(...)` site is a test fixture passing `ctx.outbox(...)` as a no-op stub (the integration and property test fixtures under `packages/dispatcher/{src,prop}/` annotate "handler-emitted outbox rows land in a later slice"; the unit-test fixture carries the same stub pattern), so capability-specific handler-emitted `outbox(...)` rows are not just unverified, they are unwired. The planned `metadata-only-set.integration.ts` (architecture.md §17.1 row 7b — Phase 4) will assert the all-or-none commit of the fuller capability-specific tuple *after* the wiring lands. Until both, that fuller tuple is design intent only.
- Conflict semantics do not apply (no CRDT update, no concurrent-write surface).

## Empirical verification (Phase 3.6, closed 2026-04-19)

ADR 0018's atomicity claim — that the five-row commit (handler `docs` write + `doc_updates` + `outbox(doc.updated)` + `audit_events` + `outbox(audit.appended)`) is all-or-none — was prose through P3.6c/d. Phase 3.6 made it executable end-to-end:

- **`packages/dispatcher/prop/writepath-atomicity.test.ts` (P3.6e commit 2, `a9ca821`)** — load-bearing artifact for the atomicity claim. A Kysely plugin's `transformQuery` arms a fault at ordinal N; the dispatcher's `runInWriteTx` runs a content-mutation capability; the suite asserts every one of the five rows is absent (reject arm) or all present (no-op arm beyond the last in-tx query). Two suites cover both runtime code paths the primitive takes (whether composed by tests or by a future non-test composition root): **cold** (9 in-tx queries — first write exercises `onLoadDocument` hydration + `doc_counters` bootstrap) and **warm** (8 queries — resident Y.Doc, no hydration SELECT). 32 tests. Five blind spots that a weaker guard would have left open are closed together: exact `callsIssued` count, per-table INSERT tag stream (`audit_events` / `doc_updates` / `doc_counters` / event-discriminated `outbox`), `doc_counters.next_seq` snapshot, `FaultInjectedError`-with-matching-ordinal assertion, and `docResidentAfterTrial` (in-memory Y.Doc residency probe — without it, a late-ordinal fault that polluted the resident Y.Doc but rolled back SQL would still pass). The test does **not** assert any per-seq audit↔update linkage (the schema does not carry that linkage and never did) — what it proves is the all-or-none commit of the five-row tuple under fault sweep. Closes Appendix C item 12.

- **`packages/sync/src/hocuspocus.integration.test.ts` (P3.6c, `5583e42`; extended P3.6e commit 1, `2d199b2`)** — proves the **`HocuspocusSync` write-tx-participation contract in isolation** (no dispatcher, no WebSocket): real `@hocuspocus/server` instance, `bind(ctx).transact(doc, fn)` against the live Y.Doc, with the per-doc concurrency mutex (Promise-chain serializer prevents `update`-listener cross-contamination across same-doc transacts), post-`await` listener-lifetime (mutations after a Promise yield still get captured), gapless seq advancement, first-write `doc_counters` bootstrap, and the open-replace `DirectConnection` singleton bound at O(1) per doc. **Boundary not exercised here:** the `fn` body is raw Y.Doc manipulation, not `BlockNoteEditor.create({ collaboration: { fragment } })` — Appendix C item 11's adapter-boundary smoke remains open (see "Out of scope" below). The WS-client rollback case is pinned here as an explicit scope limit (`rollback leaves the doc resident when a concurrent connection holds it`).

- **`packages/dispatcher/src/writepath.integration.test.ts` (P3.6b/c/d cumulative; P3.6e commit 1 added the rollback-rehydration case)** — exercises the same five-row commit with **dispatcher-side fixture capabilities** (`doc.insert_fixture`, `doc.count_fixture`, `doc.mutate_fixture` — defined inline in the test) under the four failure modes the property test deliberately abstracts over (allow / handler-throw / output-shape-violation / post-parse-deny), plus the **rollback-drops-in-memory-Y.Doc-drift** case (the `"rollback drops in-memory Y.Doc drift: post-rollback read returns pre-transact state"` test): commit A → mutate-then-throw B → no-op-read C; C must see A's content, not B's aborted state. This is where `BoundSyncService.rollback()` + `onLoadDocument` re-hydration from `doc_updates` are proven end-to-end through the dispatcher — the `HocuspocusSync` integration suite proves the primitive's contract, but the rollback round-trip needs the dispatcher's `runInWriteTx` catch path to drive it. **Coverage shape:** the fixture capabilities exercise the dispatcher + sync + writers composition that any content-mutation handler would ride; **no non-test dispatcher composition root exists yet** — every current `createDispatcher(...)` site is a test fixture with `ctx.outbox(...)` stubbed, so no real content-mutation capability has been exercised through such a path. `packages/capabilities/src/doc/create.unit.test.ts` invokes `docCreate.handler` directly with `MemorySyncService`, which proves handler-local seed-block behaviour but not the dispatcher-mediated write path. End-to-end real-capability coverage through a non-test dispatcher + Hocuspocus composition is open work — likely Phase 4 alongside the API/CLI/MCP surface adapters.

- **`packages/sync/src/blocknote.integration.test.ts` (2026-04-19)** — closes the **no-WS half of Appendix C item 11**: a headless `BlockNoteEditor.create({ collaboration: { fragment } })` is bound to the live `Y.XmlFragment` returned by `openDirectConnection.transact()`, mutated via `editor.transact(insertBlocks)`, and the resulting Yjs delta is shown to (a) flow through `HocuspocusSync`'s update listener into a `doc_updates` row + `outbox(doc.updated)` row inside the same write-path tx, (b) project back through a fresh `Y.Doc` replay of the durable update stream and produce **exactly** `[("paragraph","alpha"), ("paragraph","beta"), ("paragraph","")]` (the trailing empty paragraph is the live editor's normalisation tail — its presence is the structural proof that y-prosemirror actually dispatched, since `seedBlocks`'s pure-conversion path does not produce one; a silent regression where `editor.transact` degraded to a no-op would visibly drop that row), and (c) roll back atomically with the outer SQL tx — the editor-mutate row never lands; `BoundSyncService.rollback()` evicts the resident Y.Doc, so the next read rehydrates from committed `doc_updates` and returns *exactly* `[("paragraph","seeded")]` (no trailing empty, because the live editor never committed). **Empirical finding from this slice:** server-side `BlockNoteEditor` mutation requires a DOM shim — without `editor.mount(host)`, `insertBlocks` is a silent no-op because the y-prosemirror collab plugin only writes back to the fragment via `view.dispatch`. The first iteration of this smoke skipped `mount()` and produced zero `doc_updates` rows. Verified empirically for `insertBlocks` under `happy-dom`; the `view.dispatch` path is shared with `updateBlock` / `removeBlocks` by mechanism but only `insertBlocks` was exercised. **Substrate choice is open** — BlockNote's own tests run under `jsdom`, not `happy-dom`; substrate selection + which mutation methods are exercised under it lands at surface-adapter slice (recorded in AGENTS.md § Gotchas; not a separate ADR yet). **Out of scope here:** the WS-client concurrent-edit case from the original spec, which depends on the broadcast-buffering-until-commit fix below.

The atomicity primitive (`runInWriteTx` composed with `createDocUpdatesWriter`, `createAuditWriter`, `HocuspocusSync.bind`) is capability-shape-agnostic **within the content-mutation set** — every capability that calls `ctx.transact` rides the same wrapper. The composition itself is integration-tested at the dispatcher layer with **synthetic fixture capabilities** (`doc.insert_fixture` / `doc.count_fixture` / `doc.mutate_fixture`) rather than re-fuzzed at the property layer. **Real-capability dispatcher coverage — i.e., a registered production capability such as `doc.create` riding a non-test dispatcher + `HocuspocusSync` + SQLite composition through one test — remains open work for Phase 4** (alongside the surface adapters; no such non-test composition root exists today); Phase 3.6 deliberately validated the shared write-path composition without requiring every capability to land first. Metadata-only capabilities do not compose with `HocuspocusSync.bind` and are covered separately (see "Out of scope" below).

### Out of scope for Phase 3.6 (deferred)

- **`BlockNoteEditor.create({ collaboration })` adapter-boundary smoke — WS-client half** (Appendix C item 11). The no-WS half closed 2026-04-19 (`packages/sync/src/blocknote.integration.test.ts` — see § Empirical verification above). Still open: the original concurrent-human-WS-plus-agent-direct-connection case from the F70 spec — a second client holding an open `WebSocketProvider` while the agent edits via direct connection — which depends on the WS-client broadcast-buffering fix below.
- **Bulk-import baseline.** Construct-editor-per-op vs construct-editor-once-per-transact overhead at 50k blocks. Phase 4 / Phase 5 hardening — informs whether bulk import (e.g., 50k-block Notion export) needs an alternative batching strategy. Until then, capabilities batch via a single `editor.transact` per `ctx.transact` call.
- **WebSocket-client rollback path.** When WS clients hold the doc resident across a faulted dispatch, `bound.rollback()` cannot evict it (`getConnectionsCount() > 0` keeps Hocuspocus from unloading). The fundamentally-correct fix is buffering the broadcast until SQL commit (broadcast-first-rollback-later is wrong: clients re-send the aborted delta on reconnect). Documented as a class-docstring scope limit on `HocuspocusSync` and pinned by a regression test (`rollback leaves the doc resident when a concurrent connection holds it`). Phase 4 scope.
- **Commit-time SQLite failures** (disk-full at COMMIT, WAL corruption). Handled by SQLite's auto-rollback per its atomicity spec and are upstream-tested. The application-layer property suite injects faults pre-execute (`transformQuery` short-circuits before the driver sees the query); the tx manager treats that identically to any in-tx rejection — same `withSystemTx` catch, same `ROLLBACK` SQL — so the rollback code path is exercised on every ordinal. If a future capability introduces retry logic that a commit failure could strand, a driver-layer harness becomes worth adding.
- **Metadata-only mutation atomicity** (`block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.move`, `collection.*`). The F31 crash-fuzz exercises content mutations only — those are the ones that traverse `ctx.transact` and pair `doc_updates` with `audit_events`. Metadata-only mutations land only the relational metadata write(s) + `audit_events(allow)` + `outbox(audit.appended)` in the dispatcher's tx today; handler-emitted `ctx.outbox(...)` rows remain a no-op until later wiring. Their fuller capability-specific atomicity therefore remains both implementation debt and verification debt (architecture.md §17.1 row 7b — planned `metadata-only-set.integration.ts`). Reaches for Phase 4 alongside the metadata-only capability set.

## Revisit triggers
- Synthetic-client overhead on bulk-import workloads (e.g., importing a 50k-block Notion export) is unacceptable and a batched direct-CRDT insert path is demonstrably safe.
- A capability emerges that cannot be expressed as a block-level op (unlikely given BlockNote's schema).
- `BlockNoteEditor` API breaks in a version we cannot absorb, or `@blocknote/core` stalls (DINUM/ZenDiS funding lapses; release cadence > 6 months).
