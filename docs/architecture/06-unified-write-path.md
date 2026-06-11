## 6. Unified write path (ADR 0018)

> **Read [ADR 0022](../adr/0022-agent-editing-constraints.md) before implementing `doc.update`.** It adds an OPTIONAL per-op `expect_prior_content_hash` field (SHA-256 of canonicalized prior block JSON) on `update`/`move`/`remove`/`set_visibility` ops, plus a reserved `precondition_policy?: "strict"` discriminator. The precondition check lives inside the handler's `ctx.transact` closure and throws `StalePreconditionError` on mismatch before any op applies. The field is optional so the human UI (BlockNote via Hocuspocus) omits it; agents always send it. Reserves `AccessPath.markdown_anchor` (null-only in v1). Defers the full agent-ergonomic wrapper ADR (`doc.read` / `doc.grep` / `block.edit` etc.) to post-traffic evidence.

### 6.1 Pipeline

Every **content mutation** (any `category = "mutation"` capability that is *not* in `METADATA_ONLY_CAPABILITIES` — see §6.5 / `packages/scopes`), once a surface adapter invokes it, flows through this pipeline. Metadata-only mutations (`block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.delete`, `doc.restore`, `doc.move`, `collection.*`) take the dispatcher-tx-only path described in §6.5 / ADR 0018 — they never call `ctx.transact`, never open a Hocuspocus direct connection, never write `doc_updates`. Their **landed tuple** at the trunk composition root (`packages/api-server/src/composition/createApiDispatcher.ts`) is: the capability's relational metadata write(s) + capability-specific handler-emitted `ctx.outbox(...)` rows (e.g. `doc.publish` / `doc.unpublish` emit `doc.visibility_changed`) + `audit_events(allow)` + `outbox(audit.appended)`. The handler-emitted outbox rows are queued during `fn(extras, auditTx)` and flushed via `createOutboxWriter().append(auditTx, …)` before the `withSystemTx` region commits, so the whole tuple is single-tx atomic. The dispatcher-package's own test fixtures under `packages/dispatcher/{src,prop}/` still pass `ctx.outbox(...)` as a no-op stub — those tests verify dispatcher semantics in isolation, not trunk composition; the trunk contract is pinned by `packages/api-server/src/composition/createApiDispatcher.integration.test.ts` and will be further hardened by the N-way fault-injection property test planned in §17.1 row 7b. Red-team F3 + F9 + F10 + F31 tightened ownership, atomicity, and crash-recovery guarantees for the content-mutation pipeline below. **Single-tx semantics (F31):** `doc_updates`, `audit_events`, and both dispatcher-emitted `outbox` rows commit in one DB transaction; there is no window in which a CRDT update exists without its audit row or vice versa.

```
Request → surface adapter → dispatcher:
  1. resolve Principal, TenantContext; open OTel span
  2. permission + scope + rate-limit checks (emit deny audit + return if fail)
  3. call capability handler(ctx, input)
       handler calls ctx.transact(doc_id, fn) exactly once:
         a. open Hocuspocus direct connection; per-doc serializer acquires the doc
            (hydrate from doc_snapshots + doc_updates if not resident)
         b. direct.transact(ydoc => ...) binds
              BlockNoteEditor.create({ collaboration: { fragment } })
              and runs fn(editor) inside editor.transact(...) → one Yjs update u
         c. Yjs resource limits on u (ADR 0003); reject-on-breach
         d. capture post-state from the editor (readable inside the transact closure);
            dispatcher computes effect via
              capability.audit.effectOnAllow(input, postState) → AuditEffect
         e. TODAY: during the `direct.transact` callback, as the Yjs
            update `u` emits, Hocuspocus broadcasts it to other
            subscribers immediately (before SQL commit). On rollback,
            durable SQL state rolls
            back; `BoundSyncService.rollback()` evicts the resident
            Y.Doc only when no other connection holds the doc resident.
            With a live WS peer, the rolled-back delta stays resident
            and on that peer's local replica until reload (Phase 4 gap).
         f. Hocuspocus's per-doc DB-tx hook (onChange-equivalent) runs the single
            write transaction assembled by the dispatcher:
              BEGIN DB tx:
                compute next doc_updates.seq = prev + 1 (atomic per doc; §6.4)
                INSERT doc_updates(seq, blob, principal, session, …)
                INSERT outbox(event="doc.updated", doc_id, seq, …)
                INSERT audit_events(
                  capability_id, principal, subject, outcome="allow",
                  effect, input_hash, duration_ms, trace_id, collapsed_count=1
                )
                INSERT outbox(event="audit.appended", audit_id, …)
              COMMIT
         g. ack to waiter
         h. PLANNED (Phase 4): move the broadcast here — after COMMIT —
            via broadcast-on-commit / rollback-safe client buffering
       handler returns output O
  4. close OTel span; return O to surface adapter
```

Deny and error outcomes are written in a separate audit-only DB tx (no `doc_updates` row exists). Their effects use the `AuditDeny` / `AuditError` variants (F32 — §4.1, §16.3).

### 6.2 Ownership — who writes what

- **Dispatcher owns the write-path DB tx.** It assembles the full mutation — `doc_updates` + `outbox(doc.updated)` + `audit_events` + `outbox(audit.appended)` — and commits them together (F31). Effect is computed from `capability.audit.effectOnAllow(input, postState)` where `postState` is read inside the `direct.transact` closure before the DB tx commits.
- **Hocuspocus** supplies the per-doc serializer and the `onChange`-equivalent DB-tx hook that the dispatcher's write-path tx runs inside. It does **not** independently write `doc_updates` or `audit_events`; it provides the concurrency boundary. **TODAY** it also broadcasts the Yjs update during the `direct.transact` callback, before the dispatcher tx commits. On rollback, `BoundSyncService.rollback()` only repairs in-memory state when no other connection holds the doc resident; with a live WebSocket peer, the rolled-back delta remains resident and on the peer's local replica until reload (the `HocuspocusSync` class docstring in `packages/sync/src/hocuspocus.ts` and the `"rollback leaves the doc resident when a concurrent connection holds it"` regression test in `packages/sync/src/hocuspocus.integration.test.ts` document this). **PLANNED (Phase 4):** move broadcast to post-commit via buffered/broadcast-on-commit delivery.
- **`onStoreDocument`** (debounced, non-concurrent per doc, ADR 0006) writes `doc_snapshots`. Compaction is its job and audit is not its concern.
- **Outbox** (§6.3) is the only bridge between the write-path tx and downstream jobs; both `doc.updated` and `audit.appended` rows are inserted inside the same tx as the mutation they describe.
- **Deny / error audit writes** are owned by the dispatcher in their own audit-only DB tx, after permission-check failure or handler exception. They use `effectOnDeny` / `effectOnError` (F32).

### 6.3 Transactional outbox (F10 fix)

Background jobs (`projection_blocks`, `embed`, `mirror.project_doc`, `webhook`, `notification`) must not be enqueued outside the DB tx — a crash between commit and enqueue loses them silently. We use the **transactional outbox pattern** in both drivers:

```
outbox(
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT,
  event           TEXT NOT NULL,          -- "doc.updated" | "audit.appended" | …
  payload         TEXT NOT NULL,          -- canonical JSON
  created_at      INTEGER NOT NULL,
  forwarded_at    INTEGER,                -- NULL = pending
  forwarded_to    TEXT                    -- job id or webhook delivery id
)
```

A per-process **outbox poller** reads unforwarded rows every 250 ms (tunable), forwards each to `JobService.enqueue` with idempotency keyed on `outbox.id`, and sets `forwarded_at`. Jobs are therefore at-least-once; handlers are idempotent. On SQLite this is a small poll loop; on Postgres, pg-boss's native tx-bound `send` is an alternative but the outbox pattern keeps driver semantics identical.

**HA poller (F40 + F74).** In HA / Postgres mode the poller must be a **singleton per DB**, not per node, to avoid duplicate forwarding storms. Two-layer guarantee:

- **Primary (leader lease).** Redis lease `outbox:poller:leader` with 10s TTL; the current leader node renews on tick, re-elect on expiry. Only the leader calls `JobService.enqueue`.
- **Belt-and-suspenders (atomic claim + enqueue in one DB tx — F74).** Claim and enqueue commit **together** so a crash between steps cannot lose the enqueue. The invariant: the `forwarded_at` claim is only durable if the downstream `pgboss.job` INSERT succeeds.
  ```sql
  BEGIN;
    UPDATE outbox
       SET forwarded_at = now(), forwarded_to = $job_id
     WHERE id = $outbox_id AND forwarded_at IS NULL
    RETURNING *;
    -- No rows returned → another poller claimed it; ROLLBACK and move on.
    INSERT INTO pgboss.job (id, data, singletonKey, …)
      VALUES ($job_id, $payload, $outbox_id, …)
      ON CONFLICT (singletonKey) DO NOTHING;
  COMMIT;
  ```
  If the `INSERT INTO pgboss.job` fails for any reason (unique-violation on `singletonKey`, pg-boss table unavailable, crash mid-statement) → `ROLLBACK` undoes the `forwarded_at` claim, leaving the row for the next poll. **"Mark forwarded then enqueue" is a forbidden ordering.** For SQLite mode there's no HA concern (single writer) but the same single-tx discipline applies for crash-safety: the `forwarded_at` UPDATE and the `jobs` INSERT commit in one `BEGIN IMMEDIATE` tx.

Property test (`outbox-ha.prop.ts`): N concurrent pollers on M outbox rows forward each row exactly once. ADR 0014 is updated to note the `singletonKey = outbox.id` requirement and the single-tx contract (F74).

### 6.4 Sequence generation — atomicity (F9 + F36 + F75 fix)

`doc_updates.seq` is generated **inside** the Hocuspocus per-doc serializer (which is already non-concurrent per ADR 0006 for `onStoreDocument`; `onChange` uses the same per-doc lock for the seq assignment). Seq allocation uses a dedicated `doc_counters` table and a **row-lock** — not `SELECT max(seq) FROM doc_updates FOR UPDATE`, which is invalid SQL on an aggregate result in Postgres. The row-lock scheme works identically on both drivers.

**`doc_counters` schema:**

```sql
CREATE TABLE doc_counters (
  doc_id      UUID PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  next_seq    BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- INSERT a row on doc creation (in the same tx as docs(…)).
```

**Seq allocation — inside the write-path tx, after the per-doc serializer acquires the doc:**

```sql
-- Postgres:
SELECT next_seq FROM doc_counters WHERE doc_id = $1 FOR UPDATE;
UPDATE doc_counters SET next_seq = next_seq + 1, updated_at = now() WHERE doc_id = $1;
INSERT INTO doc_updates (doc_id, seq, …) VALUES ($1, $selected_seq, …);

-- SQLite: same query without FOR UPDATE; BEGIN IMMEDIATE serializes writers.
SELECT next_seq FROM doc_counters WHERE doc_id = ?;
UPDATE doc_counters SET next_seq = next_seq + 1, updated_at = now() WHERE doc_id = ?;
INSERT INTO doc_updates (doc_id, seq, …) VALUES (?, ?, …);
```

**Gapless seq** is preserved: `doc_counters.next_seq` increments in the same tx as the `doc_updates` INSERT. On rollback both revert, leaving `next_seq` unchanged — no gap. `UNIQUE (doc_id, seq)` is the backstop.

**Lock ordering inside the write-path tx (document explicitly to avoid deadlock):** `doc_counters` row → `doc_updates` → `audit_events` → `outbox`. All writers acquire in the same order; no cross-order paths exist.

Under HA manager rebalance, consistent-hash assignment guarantees sticky affinity; during the brief handoff window, the **old manager holds a Redis lease with TTL T (default 5s)**, and the **new manager refuses writes for 2T after lease expiry** to drain in-flight Yjs updates. MCP/API callers see `ConflictError` during that narrow rebalance window; Hocuspocus browser sessions see a "reconnecting" state and resume on the new manager. Observability: `manager.failover_count` counter + `manager.drain_window_hits` counter (ADR 0019).

**SQLite:** single-node by construction — no manager-failover race exists. `BEGIN IMMEDIATE` + WAL-mode default `SERIALIZABLE` isolation; `busy_timeout=5000` from ADR 0007 handles contention.

**Both drivers:** on `UNIQUE (doc_id, seq)` conflict the entire `ctx.transact` closure retries (up to 3 times, then `ConflictError` surfaces to the caller).

Compaction tx is disjoint from the update tx: it reads `doc_snapshots` + `doc_updates` through the current `seq`, writes a new snapshot + tombstones old updates inside its own tx. Updates arriving during compaction take a seq > compaction's checkpoint; compaction never tombstones them.

Crash during an update-write: the tx either commits or does not. Partial writes cannot persist. Crash during compaction: snapshot never appears; old data untouched; retry on next trigger.

**F68 retry-cascade bound.** The Hocuspocus per-doc serializer queues writers serially for the full `ctx.transact` closure, not just seq assignment. Retries on `UNIQUE(doc_id, seq)` conflict are therefore rare (only across dispatcher rebalance). Retry cap stays at 3; if exceeded, `ConflictError` surfaces to caller with `retry_after_ms`. Phase 3 load test verifies observed retry count < 5 at 100 concurrent writers on one doc.

**F69 compaction vs onChange serialization.** `onStoreDocument` (compaction) and `onChange` (write-path) serialize via the Hocuspocus per-doc lock; compaction cannot run concurrently with a write. Failed-insert retries produce no gaps: `doc_counters.next_seq` is incremented in the same tx as the `doc_updates` INSERT (F75); on rollback both revert, leaving `next_seq` unchanged. No gap. Property test `doc-updates-gapless.prop.ts` (§17.1) fuzzes crash sequences to assert `∀ doc: max(seq) = count(seq) AND seq values are contiguous [1..max]`.

### 6.5 Key properties

- **One `editor.transact` = one Yjs update = one `doc_updates` row = one `audit_events` row.** Atomicity for free. (F2 + F3 fix: exactly-one now means one audit row per mutation; collapse applies only to reads.)
- **No raw writes to `blocks`, `docs.content`, or any CRDT-mirror field.** Projection jobs rebuild those from the `doc.updated` outbox event.
- **Markdown-in is parsed to block ops then applied via the same transact.** See [§6.6](#66-markdown-from-agent-authoring-reconcile).
- **`ServerBlockNoteEditor.blocksToYDoc` is forbidden** — it loses history (AGENTS.md gotcha).
- **Capability handlers must call `ctx.transact` at most once.** Enforced by a runtime assertion in the dispatcher today; the planned `@editorzero/arch-lint` package will add a static `transact-called-at-most-once` rule (F89 — arch-lint is not yet implemented). Multiple mutations on the same doc batch into one transact; mutations across docs each get their own handler invocation.
- **Native moves emit `move` ops, not `remove+insert` (F33).** BlockNote drag-handle reordering and programmatic `replaceBlocks` calls that preserve block IDs produce `{ op: "move", block_id, new_parent_block_id, new_order_key }` entries in the `doc.update_batch` effect (§16.3). Downstream reducers reapply ordering without mistakenly treating a move as a delete+create, which otherwise corrupts comment anchors, attachment refs, and CRDT history attribution.

**Content mutations flow through CRDT; metadata mutations are dispatcher-tx-only (F41 + F54).** A small enumerated set of capabilities mutates only relational metadata — no Y.Doc content changes, no CRDT convergence needed:

```
metadata-only set = {
  block.set_visibility,
  doc.publish, doc.unpublish,
  doc.delete, doc.restore,
  doc.move,
  collection.create, collection.update, collection.move,
  collection.delete, collection.restore,
  workspace.update,
  workspace.member_add, workspace.member_remove, workspace.member_update_role,
  -- reserved ahead of their capabilities (ADR 0040 Step 3; handlers land at Step 8) --
  permission.grant, permission.revoke,
  space.create, space.update, space.archive, space.restore,
  space.member_add, space.member_remove, space.member_update_role,
  doc.add_guest, doc.remove_guest
}
```

**Reserved members (2026-06-12, ADR 0040 Step 3).** The Model B mutators below the divider are *reserved*: each mutates only relational rows (`spaces`, `space_members`, `grants`, `docs.access_mode`), so their write-path posture — dispatcher-owned tx, no Hocuspocus connection — is settled here before any handler exists. None is dispatchable until its `registerCapability` lands at Step 8; until then membership is zero-behaviour-change. Coherence Check 3 keeps this block in lockstep with `METADATA_ONLY_CAPABILITIES` in `packages/scopes`.

**`doc.rename` is NOT metadata-only (F54).** The doc title lives in the title block of the Y.Doc; `doc.rename` opens `ctx.transact(doc_id, editor => editor.updateBlock(titleBlockId, { content: newTitle }))` like any other content mutation. `docs.title` is a projected column (§3.5) rebuilt from the title block; `doc.rename`'s audit effect continues to be `doc.rename` (§16.3) but the write path is standard CRDT.

**Current-state caveat (2026-04-21, content-mutation slices `6077a8f` + `05bd2e0`).** The row-metadata projection that rebuilds `docs.title` / `docs.slug` / `docs.updated_at` from `doc.updated` does not yet exist. Until it lands, content-mutation capabilities run a **write-through row-metadata bridge** inside the dispatcher's single write-path tx — the handler UPDATEs the row-side columns it owns *first* (404 short-circuit if the row is missing or soft-deleted), then opens `ctx.transact` for the CRDT mutation. Both writes land atomically (same SQL tx; throw rolls back the row write, and `BoundSyncService.rollback` evicts the in-memory Y.Doc so the next read rehydrates from committed `doc_updates`).

- `doc.rename` (`6077a8f`) UPDATEs `title` + `slug` + `updated_at` then rewrites the title block via `setDocTitle(ydoc, title)` from `@editorzero/sync`. The title-slot rule lives in `setDocTitle`: block 0 heading-1 → `editor.updateBlock` in place (keeps block identity stable); otherwise `editor.insertBlocks` a fresh heading-1 at index 0 with `placement: "before"`.
- `doc.update` (`05bd2e0`) UPDATEs `updated_at` then applies the `insert`/`update`/`remove` op batch inside one `editor.transact` via `withLiveEditor`. Row-side freshness parity for `doc.list` / `doc.get` is the only bridge need — title + slug are content-owned (Codex review of the slice confirmed the thinner bridge is honest for update).

Once the projection lands, the row-side UPDATEs disappear and the handlers shrink to just the `ctx.transact` call; the surface contracts (input / output / audit effect) do not change.

**v1 slug semantics — slug tracks title.** The slugify step inside the handler mirrors `doc.create`'s: `docs.slug` is re-derived from the new title on every rename (kebab-case; empty base → `"untitled"`). Pragmatic for v1 because `doc.list` / `doc.get` are the only readers today — listing coherence + `docs.slug` NOT NULL are the only concerns in play, and slug-tracks-title satisfies both. Callers that expect stable public-route URLs independent of title get a future `doc.set_slug` capability that decouples the two; until that lands, rename and slug change together.

These capabilities in the metadata-only set take the dispatcher-owned DB tx without opening a Hocuspocus direct connection. The `transact-called-at-most-once` lint (§16.8) allows zero calls for capabilities in the metadata-only set; the `no-raw-ydoc-access` lint's whitelist applies to the Hocuspocus integration layer (`packages/sync/**`) and not these handlers (they never touch Y.Doc). Invariant 7 in AGENTS.md is read as "all *content* mutations flow through the CRDT"; metadata mutations are outside its scope, and §6.2 explicitly lists them as dispatcher-owned.

### 6.6 Markdown-from-agent authoring (reconcile — F8 + F37 + F44 + F66/F73 fix)

**Why `reconcile_base_token`, not `state_vector_at_fetch`.** An earlier iteration required callers to send the Yjs state vector captured when they fetched the Markdown. That shape fails in practice: a minimal HTTP agent that ran `curl /api/doc.get_markdown | jq .markdown | edit | curl -X POST /api/doc.update_from_markdown` has no way to produce a Yjs state vector without shipping Yjs into its runtime. More importantly, `fetchedBlocks[]` cannot be materialised from a state vector alone — a state vector is a vector-clock summary, not a serializable snapshot of block content. Reconcile needs the **block array as it existed at fetch time** as the baseline for three-way merge; the server must retain that baseline itself and hand the caller an opaque handle.

Flow:

```
doc.update_from_markdown({
  workspace_id, doc_id, markdown,
  reconcile_base_token: string,                   // F66/F73 — opaque server-issued handle
                                                  //   required in mode="reconcile" and "strict"
                                                  //   optional in mode="replace"
  mode: "reconcile" | "replace" | "strict",       // F37 — default "reconcile"
  allow_foreign_ids?: boolean                     // F44 — default false
}):
  1. Parse markdown → mdast (remark-parse + remark-directive, pinned).
  2. mdast → incomingBlocks[] via per-type fromMarkdown (ADR 0013).
  3. Resolve reconcile_base_token →
       { fetchedBlocks[], fetchedStateVector } from `reconcile_bases` (§3.18).
     If token is missing / expired / not found for this (workspace_id, doc_id):
       throw ConflictError("stale_fetch", { max_reconcilable_age_ms }).
     Caller re-runs doc.get_markdown to obtain a fresh token.
  4. In ctx.transact(doc_id, editor => { … }):
       a. Read live_state_vector = Y.encodeStateVector(editor.yDoc).
          Read currentBlocks[] from the editor.
       b. ops = reconcileBlocks(fetchedBlocks, currentBlocks, incomingBlocks, mode, allow_foreign_ids)
       c. for each op: editor.applyOp(op)
       d. return { ops_applied, diagnostics }
```

`doc.get` and `doc.get_markdown` return `reconcile_base_token` alongside content. The token identifies a server-retained snapshot in `reconcile_bases` (§3.18); TTL is `max(72h, tombstone_retention_floor)` — the same floor as `doc_updates` reaper (ADR 0007) so a restore that can reach the journal can also reach the baseline. Token issuance is recorded as an `AuditEffect` variant (`doc.reconcile_base_token` — transient, so GC activity is auditable). A dedicated reaper batch `"reconcile_bases"` (§3.14, §13) drops expired tokens.

**Ergonomics (F65).** Simple HTTP agents that `curl`'d markdown get the token back in the response and pass it verbatim — no Yjs machinery on the client, no state-vector production. The token is an opaque string as far as the caller is concerned.

Reconcile contract (v1):

- **Block ID is load-bearing.** Agents that expect stable round-trip must preserve block IDs in the markdown they emit (HTML comment for lossless; directive attribute for directive/opaque — ADR 0013 §block-ids). If an `incoming` block carries an ID matching a `current` block **and** the block types match, `reconcile` emits an `update`, never a `remove+insert`.
- **Orphans are preserved, not removed, in `mode=reconcile`.** A block present in `current` but not in `incoming` (no matching ID) is **kept** — this prevents the silent-clobber race where human keystrokes land between markdown-fetch and markdown-apply.
- **Move, not remove+insert (F33).** If an ID matches between `current` and `incoming` and the block's parent or adjacency has changed, reconcile emits `{ op: "move", block_id, new_parent_block_id, new_order_key }` — not a remove+insert pair. This preserves comment anchors and attachment refs targeting that block.
- **Three modes (F37):**
  - `reconcile` (default): concurrent-edit safe. At the start of the transact, reconcile compares the `fetchedStateVector` resolved from the token with `live_state_vector`.
    - Identical → proceed with the straight three-way merge.
    - Different → for each ID present in both `incoming` and `current` where `current[id]` differs from `fetched[id]`, treat as conflict. Default: **preserve `current[id]` (human/last-writer wins)**, surface the block id in the returned `diagnostics.conflicts[]`, do NOT emit `update` for that block. Emit `update` only for blocks in `incoming` that were unchanged in `current` since fetch.
  - `strict`: throws `ConflictError` on any concurrent change since fetch. For agents that must refuse to land edits if humans moved.
  - `replace`: clobber mode — reconcile emits `remove` for any block not in `incoming`. Intent is explicit; accident is not possible. `reconcile_base_token` is optional in this mode.
- **Unknown-origin IDs are defensively handled (F44).**
  - `incoming` block with ID X that does not exist in `current` → treat as `insert` with a **fresh ID** (not the claimed X); the mapping is returned in `diagnostics.remapped_ids[]`. Operators who trust the agent can opt in via `allow_foreign_ids: true` to preserve claimed IDs; default is `false`.
  - `incoming` block with ID X matching `current` but with a **mismatched `type`** (e.g., `current[X].type=paragraph`, `incoming[X].type=heading`) → treat as `remove + insert-with-new-id`, returned in `diagnostics.type_shifted[]`. Intent-preserving; blocks cross-block hijack attempts.
- **In-flight concurrent writes.** Before the transact commits, reconcile compares `live_state_vector` (captured at step 4a) to the current state vector. If they differ (meaning another update landed on the same doc inside the transact), reconcile **retries the diff** against the new `current` up to 3 times, then throws `ConflictError`. Caller retries the whole capability.

Property tests:

- `reconcile.prop.ts` asserts — for fuzzed `(fetchedBlocks, currentBlocks, incomingBlocks, concurrent_human_edits_during_parse)` — in `mode=reconcile`, a human's concurrent insert is never removed and a block edited by the human between fetch and apply retains the human's edit (diagnostics list the conflict).
- `reconcile-foreign-ids.prop.ts` asserts — reconcile applied to markdown with fabricated IDs produces fresh-ID blocks, never updates of existing blocks, when `allow_foreign_ids=false`.
- `reconcile-base-token-ttl.prop.ts` asserts — expired token → `ConflictError("stale_fetch")`; token valid + concurrent human edit → human wins on overlap; token valid + no concurrent edit → agent applies cleanly.
