# 0043 — The audited WS write lane: broadcast-after-commit substrate, `doc.apply_update`, the WS surface as adapter

- **Status:** Accepted (2026-06-13; cross-model design round folded pre-build — see Review trail)
- **Supersedes / amends:** executes the slice-B obligations recorded in ADR 0030's dated WS-attach amendment and `packages/sync/src/hocuspocus.ts`'s residual notes; extends ADR 0038 (owned editor write path) to the raw-delta lane; no prior decision is reversed.

## Context

Slice A (task #15) production-attached the collab WebSocket with every ADR 0030 blocker closed — but **universal `readOnly`**: a WS-applied Yjs update would mutate durable state outside the dispatcher, violating invariant 3 (every mutation = exactly one audit row) and invariant 5 (surfaces don't re-implement permission logic). Two residuals were recorded for this slice: the **pre-commit broadcast** (an HTTP `ctx.transact` mutates the resident Y.Doc before its SQL tx commits; attached clients can receive a delta that subsequently rolls back — the eviction/poisoning machinery exists solely to contain that), and the **write lane itself**.

Verified against the pinned Hocuspocus 3.4.4 source (`dist/hocuspocus-server.esm.js`) at design time:

- `Connection.handleMessage` awaits the per-connection `beforeHandleMessage(connection, rawData)` **before** `MessageReceiver.apply`; a hook rejection closes the connection. Veto-or-pass only — no frame skip, no rewrite.
- The only Yjs-mutating sync subtypes are `SyncStep2` and `Update` (inside `Sync`/`SyncReply` envelopes). `SyncStep2` from a readOnly connection acks `syncStatus(true)` iff `Y.snapshotContainsUpdate` holds, else `false`; plain `Update` nacks `false` unconditionally.
- `Awareness` applies with no readOnly check (ephemeral presence). `BroadcastStateless` relays to every connection on the doc with **no readOnly check** — an unaudited cross-client input channel the product does not use.
- Yjs: applying an already-contained update fires no `update` event (structural no-op); novel updates always fire.
- The ceiling resolver exposes no `canWrite` — row-level standing for every content mutation today is `doc:write` scope + `assertCanRead`. Role tiers (`view`/`comment`/`edit`) are not yet row-enforced for writes on **any** surface.

## Decision 1 — Broadcast-after-commit lands first; the resident Y.Doc holds committed state only

The write lane does not land on the current resident-mutation substrate (review MUST-FIX 1: slice B makes browser deltas first-class writes; shipping them on the known pre-commit-broadcast substrate inherits the exact hole the slice closes).

`ctx.transact(doc_id, fn)` is reworked: `fn` receives a **clone** built from the resident doc caught up to committed `doc_updates` **plus this binding's own staged blobs** (read-your-own-writes across multiple transacts in one dispatch). Captured updates stage on the binding; `DocUpdatesWriter` persists them in the open SQL tx as today. After the tx **commits**, the dispatcher calls the new `bound.commit()`, which applies staged blobs to the resident doc under the per-doc lock — apply *is* broadcast. Rollback discards staged blobs; the resident is never touched.

- **Resident freshness contract:** resident = committed-as-of-last-catch-up. Catch-up (replay `doc_updates` rows with `seq > appliedSeq`, per-doc `appliedSeq` tracked sync-side, `readByDocSince` reader) runs post-commit, pre-clone, and on WS attach.
- **Retired:** the `#evictResident`/`#poisoned` machinery and the read path's documented visibility gap — normal rollback no longer leaves anything to evict. Reads become committed-only by construction.
- **Pinned property (the review's wording):** throw after a staged Y mutation while WS clients are attached ⇒ no broadcast reaches them, the resident bit-equals cold replay of committed `doc_updates`, and the next read/transact sees committed-only state.

## Decision 2 — `doc.apply_update`: the raw-delta capability

One new capability carries every WS-originated content mutation — and, by invariant 4, gives agents the same raw-delta push over HTTP/CLI/MCP (a Yjs-native agent can sync a local doc without re-deriving block ops).

- **Input:** `{doc_id, update}` — base64 Yjs update with a schema-level size cap. **Requires** `doc:write` + the Step-6 ceiling (`assertCanRead` on the live row) — exact parity with `doc.update`'s posture today. The role-aware `canWrite` ladder is deliberately **not** invented here: it narrows every content mutation on every surface and lands as its own increment across them all (see Non-goals).
- **Validation (owned-namespace, not just PM-schema — review SHOULD-FIX 3):** inside the transact, post-apply: (1) the doc's share map contains **exactly** the owned fragment namespace (`DOC_FRAGMENT` and nothing else) — any other top-level shared type refuses; (2) the fragment passes the owned structural check (`yXmlFragmentToProseMirrorRootNode` → `check()`). Violations throw ⇒ tx rollback ⇒ the delta never reaches the resident doc. **Repair, not refuse:** `id`-less blocks (the editor protocol's normal state for fresh inserts — browser mints `id:""` until the server mints) get server-minted `BlockId`s as a follow-up Y mutation captured into the same blob. O(doc) per frame accepted for v1.
- **Audit effect carries handler-computed truth (review MUST-FIX 2, the replay-fix class):** the effect carries the **exact merged post-repair blob that was persisted** (+ minted block ids) — never the raw client input, which the repair step may have extended. "The audit log alone reconstructs final state" stays literal for this lane. Same `REPLAY_CLASS` treatment as `doc.update_batch`.
- **The no-op lane:** normal sync chatter must not mint allow rows. The WS adapter **preflights** `Y.snapshotContainsUpdate(resident, update)` and skips dispatch entirely for contained updates (provider re-sends, handshake echoes). The residual race — an update that becomes contained between preflight and apply — yields an empty capture inside the handler; that dispatch returns an explicitly marked no-op output rather than pretending a mutation happened. Named here because the dispatcher has no seam to suppress an allow row today; the marker keeps the row honest and greppable.
- **Surfaces at birth:** `api`, `cli`, `mcp`. The `ui` cell arrives with the SPA collab-provider slice (the live editor over WS is the proof); until then it is one more honest `UI_PENDING` row.

## Decision 3 — The WS adapter: Shape B, hook-gated dispatch, connections stay protocol-honest

The adapter is `beforeHandleMessage` (review SHOULD-FIX 1 concurrence: the facade-socket alternative re-implements framing + ack semantics — a larger drift surface than a hook-gated pass-through on the verified pinned source).

- Connections attach with `readOnly = false` at the Hocuspocus layer; **the hook is the gate**. It decodes the frame: update-bearing subtypes (`SyncStep2`, `Update`) extract the update payload, preflight contained-ness, and **dispatch `doc.apply_update` synchronously** with a per-frame re-resolved principal. On success the hook resolves; the native apply re-applies the just-committed update — a Yjs structural no-op (no second event, no second broadcast) — and acks `syncStatus(true)` honestly. On dispatch refusal the hook rejects ⇒ Hocuspocus closes the connection: a client pushing writes it lacks standing for loses the socket, which is also the revocation posture.
- **`BroadcastStateless` is rejected** in the same hook (review SHOULD-FIX 2): it is an unaudited cross-client relay inside an authorized room and nothing in the product sends it. A future stateless feature gets a named, rate-limited design — not this inherited raw channel. Plain `Stateless` stays inert (no server callback registered).
- **Protocol-closure tests** pin the total classification (review SHOULD-FIX 1): `SyncStep1` passes undisturbed (no dispatch); novel `SyncStep2` dispatches; contained `SyncStep2` skips; novel `Update` dispatches; `Awareness`/`QueryAwareness` pass without audit; `Auth` unchanged; `Close` passes; unknown types close; `BroadcastStateless` closes. A version-pin assertion fails the suite on any `@hocuspocus/server` bump so the classification gets re-verified against the new source before runtime ever sees it.
- Awareness stays unaudited (ephemeral presence, outside document state); rate-limiting is a later observability concern.

## Decision 4 — Bearer/agent WS auth (H8-aware)

`collabAuthorize` grows the `Authorization: Bearer` arm beside the cookie arm: api-key and delegated-agent principals resolve per Auth frame exactly like users. Attach-time standing and write dispatch both reuse the H8-aware gate composition — **never** the static `effectiveScopes` shortcut for agents (the review's emphasis): a delegated agent's reach is `acting_as` ∩ delegator at check time, every time. The Origin allow-list stays **cookie-lane-only**: CSRF is an ambient-credential attack and bearer tokens are not ambient, so an absent Origin admits on the bearer arm and still refuses on the cookie arm.

## Decision 5 — Event-driven revocation closes gate the readOnly lift (review MUST-FIX 3)

Per-frame re-resolution protects the next **write**; it does nothing for a passive attached socket that keeps **receiving** broadcasts after its grant/session/membership is revoked — a real read leak once writable production sockets exist. Therefore, **before** universal `readOnly` lifts in production:

- `attachCollab` maintains a socket registry keyed by `{user_id, session_key}` captured at upgrade time (our adapter layer owns the upgrade; Hocuspocus context deliberately stays identity-free).
- A composition-root tap fires after revoke-class capability commits (`permission.revoke`, `doc.remove_guest`, `space.member_remove`/`update_role`, `workspace.member_remove`/`update_role`, `doc.delete`, `space.archive`) and on Better Auth sign-out: close the affected subject's sockets (by `user_id`) or the session's sockets (by `session_key`). A surviving legitimate client reconnects and re-runs `collabAuthorize`, which now refuses.
- The in-process tap suffices; the §12 jobs runner is not a prerequisite. Granularity can refine later (per-doc targeting); closing a subject's sockets outright is correct today — re-attach is cheap and re-auth is the authority.

## Build order within the slice

1. Broadcast-after-commit substrate + property pins; poison/evict machinery retired (Decision 1).
2. `doc.apply_update` end-to-end: schemas, registry, handler (validation + repair + no-op marker), routes, CLI, MCP, contract rows, replay-walk extension (Decision 2).
3. The WS adapter: hook-gated dispatch + protocol-closure matrix + `BroadcastStateless` rail (Decision 3).
4. Bearer/agent arm on `collabAuthorize` (Decision 4).
5. Socket registry + revocation tap (Decision 5) — then, and only then, the production `readOnly` lift.

## Non-goals

- **SPA collab-provider adoption** — the live editor over WS is its own slice (flips `doc.apply_update`'s `ui` cell; client-side `syncStatus` handling gets verified there).
- **The role-aware `canWrite` ladder** — a system-wide narrowing of every content mutation on every surface; lands as one coordinated increment after this slice, not smuggled in per-lane. Until then `doc.apply_update` matches `doc.update`'s standing exactly — no widening.
- **Frame coalescing** — load-triggered evolution; it trades collaboration latency against tx volume and complicates the one-dispatch-one-audit-row model. Per-frame dispatch is the v1 contract (no-op chatter excluded by preflight).
- **Awareness audit / rate limits** — presence stays ephemeral and unaudited.
- **Stateless messaging features** — the channel is closed, not designed.

## Consequences

- Invariants 3, 5, and 7 extend to live collaboration: every WS-originated mutation is one dispatched capability, one audit row carrying the exact persisted blob, one `doc_updates` row — and the resident doc can no longer broadcast state that later rolls back, on any lane.
- The sync layer simplifies: eviction/poisoning and the read-path visibility gap are deleted rather than worked around; rollback becomes "discard staged."
- The dispatcher write path gains a post-commit step (`bound.commit()`); its failure mode (commit succeeded, resident apply failed) is a process-level inconsistency window — the resident catch-up on next open self-heals it, and the property suite pins that.
- Per-frame dispatch puts a SQL tx + audit row on every keystroke batch — accepted v1 cost, measured before any coalescing is considered.
- A second content-effect shape (`doc.apply_update`'s blob beside `doc.update_batch`'s semantic ops) joins the forensic plane; the audit UI renders it as an opaque delta with minted-id annotations.

## Review trail (cross-model, 2026-06-13)

Codex reviewed the full design brief pre-build; dispositions:

- **MUST-FIX 1 (applied — Decision 1):** broadcast-after-commit is the substrate, not a follow-up. "Shipping that on the known pre-commit-broadcast substrate means the new path knowingly inherits the exact correctness hole the slice is supposed to close." The exact rollback property he specified is the pinned test.
- **MUST-FIX 2 (applied — Decision 2):** the audit effect carries the exact persisted post-repair blob, "the same 'effect carries handler-computed truth' class as the replay-engine fixes"; the no-op lane is named (preflight skip + marked residual race no-op) so sync chatter cannot become audit spam.
- **MUST-FIX 3 (applied — Decision 5):** event-driven closes are a gate before writable production sockets, not belt-and-suspenders — "revoked but still watching live edits until disconnect is a real read leak." Mechanics refined to a socket registry keyed `{user_id, session_key}` with targeted closes (within his requirement; he asked for in-process tap, granularity unspecified).
- **SHOULD-FIX 1 (applied — Decision 3):** Shape B chosen with the protocol-closure matrix he enumerated plus a version-pin assertion; his framing "B's invariant rests on total classification of update-bearing frames" is the test's docstring.
- **SHOULD-FIX 2 (applied — Decision 3):** `BroadcastStateless` shut now.
- **SHOULD-FIX 3 (applied — Decision 2):** validation extended from PM-schema to owned-namespace exactness ("`readBlocks` validates the owned fragment shape but does not by itself prove the update did not mutate some other shared type").
- **Concurrences kept:** awareness unaudited; per-frame volume acceptable v1 with no-op skip; coalescing later; bearer/Origin split right; H8-aware composition mandatory for agents.

## Revisit triggers

- The SPA provider slice measures real frame rates → revisit coalescing with data.
- A `@hocuspocus/server` bump → the version-pin assertion forces re-verification of the message-type classification and the readOnly ack semantics.
- Multi-process deployment (more than one trunk) → the socket registry and revocation tap need a cross-process channel (the §12 jobs runner is the natural host).
- The `canWrite` ladder lands → `doc.apply_update` inherits it with every other content mutation; its ADR records the ladder shape.
