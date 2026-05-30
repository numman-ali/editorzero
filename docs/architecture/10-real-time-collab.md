## 10. Real-time / collab

### 10.1 Hocuspocus topology

- **Single node:** in-process Hocuspocus bound to the same Hono app. No Redis.
- **HA:** multi-node with Redis fan-out (worker-nodes + single-manager, per Hocuspocus 3.x docs). Sticky per-doc assignment via consistent-hash; rebalance on node drain.
- **Manager failover (F36).** Each manager holds a per-doc Redis lease `hocuspocus:manager:{doc_id}` with TTL **5s** (tunable). On drain, the outgoing manager relinquishes the lease; the incoming manager waits for the lease to expire and then **drains for 10s** before accepting writes for that doc. The 5s + 10s window matches §6.4's seq-atomicity contract. During the drain window, MCP/API writers see `ConflictError`; Hocuspocus browser sessions see a `reconnecting` state and reattach on the new manager. `manager.failover_count` and `manager.drain_window_hits` are OTel counters (ADR 0019).

### 10.2 Authentication (`onAuthenticate`)

Browser + non-browser clients both present a bearer (Better Auth session token or API key). Resolved to `Principal`; session bound to `{principal, workspace_id, doc_id, token_id}`. `onAuthenticate` runs on connection establishment only — in-session revocation uses the explicit mechanism in §10.3.

### 10.3 In-session revocation cascade (F7 + F43 + F49 + F78 fix)

Hocuspocus has no built-in "revoke this open session now" hook. ADR 0016's revocation-cascade step 4 is implemented by us, as follows:

- **Session registry.** `packages/sync/src/session-registry.ts` holds **three indexes** (F43 + F78):
  - `Map<TokenId, Set<SessionHandle>>` — primary, for token revocation.
  - `Map<PrincipalId, Set<SessionHandle>>` — for member-removal cascade (walks all tokens bound to a principal).
  - `Map<UserId, Set<SessionHandle>>` — keyed by `acting_as_user_id`, for delegator revocation.
  On `onAuthenticate`, the session is added to all applicable indexes (the `acting_as_user_id` index only when `acting_as` is non-null); on `onDisconnect`, removed from all.
- **Revoke events.** Multiple emitters, one handler. Handlers subscribe to all three revocation-event kinds:
  - `token.revoke` / `agent.revoke` → emit `revoked:{token_id}`.
  - `member.remove(user_id)` → walks that principal's active tokens and emits `revoked:{principal_id}` for every active token bound to that user, **and** `revoked-delegator:{user_id}` so every agent currently `acting_as` that user is closed (F78).
  - `token.revoke(token_id where acting_as=user_id)` → emits `revoked-delegator:{user_id}` in addition to the token-specific event (F43).
  Events land on the in-process `EventBus` plus Redis pub/sub in HA mode.
- **Handlers.**
  - On `revoked:{token_id}`, walk `sessions_by_token[token_id]`, close each with WebSocket close code `4401` ("auth revoked") and a structured close frame.
  - On `revoked:{principal_id}`, walk `sessions_by_principal[principal_id]` and close those sessions.
  - On `revoked-delegator:{user_id}`, walk `sessions_by_acting_as[user_id]` and close those sessions too.
- **Persistent revocation log (F49).** Redis pub/sub is best-effort; the belt-and-suspenders layer persists every revocation:
  ```
  revocation_log(
    token_id        TEXT,
    principal_id    TEXT,
    acting_as_user_id TEXT,
    revoked_at      INTEGER,
    revoked_by      TEXT
  )
  ```
  Each app node polls `SELECT * FROM revocation_log WHERE revoked_at > last_seen` at 1 Hz in parallel with pub/sub. A Redis outage that drops a pub/sub message still closes sessions within ~1s via the poller.
- **Forced re-authentication.** Every open Hocuspocus session re-runs `onAuthenticate` on a **random interval uniformly distributed in [8 min, 12 min]** measured from the session's last auth (F67). Jittering prevents stampede at minute boundaries for large workspaces where many sessions would otherwise re-auth simultaneously. This is the slow path; catches any drift the fast paths miss — revoked tokens rejected at re-auth even if both event paths failed. Metric `auth.session_reauth_latency` (ADR 0019); alert when `qps > 3× baseline`.
- **Latency target.** p99 < 500 ms from `token.revoke` audit row to session-closed broadcast via the primary path; p99 < 5s via the poller under Redis-disconnect conditions. Both observed via OTel span `session.revoke_close`.
- **Audit.** `token.revoke`, `agent.revoke`, `member.remove` audit effects record session count closed at revoke time (zero if none open).

Property tests:

- `session-revocation.prop.ts`: for any mix of `{open-session, token.revoke}`, after `token.revoke` the revoked token cannot push another Yjs update on any open socket within T=1s. Tested against both single-node and multi-node (pub/sub) configurations.
- `delegator-revocation.prop.ts` (F43): `(Bot42 delegated as Alice; revoke Alice) ⇒ Bot42's Hocuspocus session closes within 1s`. Effective-permission intersection still applies on the next request; closing the open socket ends the story.
- `revocation-redis-partition.prop.ts` (F49): revocation during simulated Redis disconnect still closes the session within 5s via the poller path.

### 10.4 Resource enforcement (ADR 0003)

In `onChange`:
- Reject updates > 256 KB.
- Drop session after sustained > 100 updates/sec.
- Doc > 50 MB state → read-only mode, admin flagged. `admin.unlock_doc` capability (§Appendix A) clears the read-only flag after the doc is reduced or split.
- Apply-pass in a worker-thread sandbox; reject if post-apply delta exceeds per-update cap.

**Event-loop lag budget (F52).** p99 event-loop lag on the Node process hosting Hocuspocus must stay **< 50 ms**. At 500 updates/sec the Yjs `applyUpdate` CPU time alone can saturate the loop on small hosts; this is the **first operator ceiling that bites** before memory or storage. Exposed as a golden signal (ADR 0019: `nodejs.eventloop.lag.p99`). Alert threshold: **p99 > 100 ms for 5 minutes**. Revisit-trigger for ADR 0006: sustained breach at the stated scale target → offload CRDT apply to a worker pool or sidecar process.

### 10.5 Doc residency policy (F29 + F38 fix)

`ctx.transact(doc_id, fn)` guarantees the Y.Doc is loaded before `fn` runs. Residency is Hocuspocus-owned and scales **horizontally**, not vertically — a single process cannot cache every hot doc at scale target, and §10 policy reflects that.

- **Hydration.** On first access, Hocuspocus reads the latest `doc_snapshots` + subsequent `doc_updates` into an in-memory Y.Doc. Hydration is per-doc-serialized; concurrent `transact` calls wait on the same hydration future.
- **Retention.** Y.Doc stays in memory while any browser subscriber is attached **or** for `inactive_ttl` seconds after last activity. Two-tier TTL:
  - **Active sessions:** `inactive_ttl=300s` for sessions with heartbeat in last 60s.
  - **Fully idle:** `inactive_ttl=60s` when no session has heartbeated recently.
- **Horizontal sizing (F38).** Scale out across N nodes rather than up. Worked example at the declared scale target: 10k users → ~2000 concurrent hot docs × ~1 MB avg = ~2 GB aggregate resident state, served by 2 nodes @ 2 GB cap each (or 1 node @ 4 GB cap). Operators estimate sizing as `N nodes × avg-doc-RAM × hot-doc-count-per-node`.
- **Memory cap.** Default per-process cap: **50% of available process RAM**, tunable via `EDITORZERO_HOCUSPOCUS_MAX_RAM_BYTES`. Per-process Y.Doc count + aggregate RAM are OTel gauges (ADR 0019).
- **Split residency from flush.** Eviction marks `docs.pending_snapshot_seq = last_seq`; a **low-priority background job** coalesces flushes, respecting `onStoreDocument`'s non-concurrency-per-doc guarantee (ADR 0006). This decouples the eviction path from snapshot I/O latency.
- **Eviction trigger.** On per-process cap breach, evict least-recently-used docs with zero subscribers first. If the compaction-flush job is saturated, writes back-pressure on the write-path tx (admin dashboard surfaces the queue depth; alert at >100).
- **Admin dashboard surfaces.** Residency size, eviction rate, pending-flush queue depth. Alert thresholds:
  - `eviction_rate > 10/min` sustained 5 min.
  - `pending_flush_queue_depth > 100`.
- **Crash recovery.** If the process crashes before the coalesced flush runs, `doc_updates` past the last snapshot rehydrates the Y.Doc on next access. `pending_snapshot_seq` lets the flush job resume without re-reading the journal.

Property test (`doc-residency.prop.ts`): `ctx.transact` on a non-resident doc hydrates, applies, persists; eviction-then-re-access produces identical post-state.

### 10.6 Sync for non-browser clients

API/CLI/MCP handlers are clients of the same Hocuspocus path. `ctx.transact(doc_id, fn)` opens a direct connection to the live `Y.Doc` and binds a `BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>` to its `Y.XmlFragment`; the handler calls `editor.insertBlocks/updateBlock/removeBlocks` inside `editor.transact(...)`. `@blocknote/server-util`'s `ServerBlockNoteEditor` is a conversion surface only (blocks ↔ HTML/Markdown/Y.Doc) and is not used to mutate — ADR 0018. No parallel write path. See §6.
