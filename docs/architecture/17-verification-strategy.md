## 17. Verification strategy

### 17.1 Stack wiring (ADR invariant mapping)

This table is the **target invariant → test map**, not a claim that every package path below exists in the current tree. Unless a row explicitly calls out something as "currently landed", read package/test paths here as planned endpoints. As of P3.7, the landed proofs relevant to this sweep are the F31 crash-fuzz row plus the runtime/fixture coverage called out in row 7a; the cross-surface contract rows remain planned because `packages/contract-tests` and `apps/{app,admin}` are still absent — but the surfaces those rows generate against (`packages/api-server`, `packages/mcp-server`, `apps/cli`) have all landed, so the remaining gap is the contract-test harness itself, not the adapters.

| # | Invariant (AGENTS.md) | Test kind | Location |
|---|---|---|---|
| 1 | Per-block-type Markdown fidelity round-trips cleanly under its declared tier | **Property** | `packages/blocks/test/fidelity.prop.ts` — per-type fuzz; 10k/PR, 1M nightly (ADR 0013) |
| 1 | Multi-block document round-trip | **Property** | `packages/docs/test/doc-roundtrip.prop.ts` |
| 2 | Concurrent human/agent edits converge across replicas | **Property** | `packages/sync/test/convergence.prop.ts` — fuzz N-client sequences (ADR 0003/0006) |
| 3a (F1) | Audit replays `PersistentWorkspaceState` | **Property** | `packages/audit/test/replay.prop.ts` — §9.1 |
| 3b (F1) | CRDT state reproducible from snapshots + updates | **Property** | `packages/sync/test/crdt-durability.prop.ts` — §9.1 |
| 3 | Every *mutation* produces exactly one audit entry (no collapse) | **Unit + contract** | `packages/capabilities/test/audit-one-per-mutation.unit.ts` + `packages/contract-tests/test/collapse-policy.ts` |
| 3 | Sequence assignment is atomic + gapless per doc (F9) | **Property** | `packages/sync/test/seq-atomicity.prop.ts` |
| 3 | Transactional outbox never loses a downstream event (F10) | **Property** | `packages/jobs/test/outbox.prop.ts` — crash-fuzz |
| 4 | Every capability exists on every type-compatible surface | **Planned contract** | Planned `packages/contract-tests/test/surface-parity.ts` — generated from the registry once the surface adapters and contract-test package land |
| 4 | Same input on all surfaces produces same output + audit | **Planned contract** | Planned `packages/contract-tests/test/cross-surface-fixture.ts` — depends on `packages/contract-tests` (absent) and `apps/{app,admin}` (absent); the three transactional surfaces it generates against (`packages/api-server`, `packages/mcp-server`, `apps/cli`) are landed. Adapter-level MCP↔registry parity is enforced today in `packages/mcp-server/src/create-mcp-handler.integration.test.ts` + `packages/api-server/src/composition/mcp-chain.integration.test.ts`. |
| 5 | Permission checks in capability layer | **Contract + integration** | `packages/capabilities/test/permission-matrix.ts` (allow/deny fuzz) + `packages/db/test/tenant-isolation.prop.ts` (F4 cross-tenant fuzz against both drivers) |
| 6 | Soft-deletes recoverable via first-class capability | **Property** | `packages/capabilities/test/inverse-restore.prop.ts` (ADR 0017) |
| 7a | All **content** mutations flow through CRDT via `ctx.transact` | **Static + integration** | Planned `@editorzero/arch-lint` rules (`no-raw-ydoc-access`, `transact-called-at-most-once`) — F89, not yet implemented. **Currently landed:** dispatcher runtime backstop (F92 — `TransactCalledTwiceError` + at-most-once guard in `packages/dispatcher/src/dispatcher.ts`) + dispatcher composition coverage via inline fixture capabilities at `packages/dispatcher/src/writepath.integration.test.ts`. **Open:** real-capability integration through dispatcher + Hocuspocus + SQLite is not yet exercised in any test (P3.6f scope acknowledgement, Phase 4 follow-up alongside surface adapters). |
| 7b | Enumerated **metadata** capabilities (`block.set_visibility, doc.publish, doc.unpublish, doc.delete, doc.restore, doc.move, collection.*`) legally skip `ctx.transact` | **Static + property** | Planned `@editorzero/arch-lint` whitelist in `transact-called-at-most-once` (zero calls allowed for enumerated set) — F89, not yet implemented; `packages/scopes` `METADATA_ONLY_CAPABILITIES` export is canonical and coherence script diffs it against `architecture.md` §6.5; atomicity contract for the metadata-only tuple (`docs` UPDATE + `audit_events(allow)` + `outbox(audit.appended)` + handler-emitted `outbox(*)`) is pinned by `packages/api-server/prop/metadata-only-atomicity.test.ts` under N-way fault injection against the real `createApiDispatcher` factory (landed 2026-04-21, uses `doc.publish` as the capability fixture — every other metadata-only capability runs through the same queue-and-flush primitive and is covered by the same property) |
| 8 | Agents are first-class principals | **Contract** | `packages/capabilities/test/agent-parity.ts` — every human-usable capability has an agent-usable analog or a declared `humanOnly` rationale |
| — | Published-cache visibility (F5) | **Property** | `packages/app/test/public-cache-invariance.prop.ts` |
| — | Reconcile does not clobber concurrent edits (F8) | **Property** | `packages/docs/test/reconcile.prop.ts` |
| — | In-session token revocation closes sockets < 1s (F7) | **Property** | `packages/sync/test/session-revocation.prop.ts` |
| — | Doc residency hydrate + evict + re-access (F29) | **Property** | `packages/sync/test/doc-residency.prop.ts` |
| — | Attachment GC never removes pinned-version blobs (F18) | **Property** | `packages/capabilities/test/attachment-lifecycle.prop.ts` |
| — | Attachment orphan uploads reaped after expiry (F80) | **Property** | `packages/capabilities/test/attachment-orphan-cleanup.prop.ts` |
| — | Embedding reindex flip preserves recall (F30) | **Property** | `packages/search/test/reindex-flip.prop.ts` |
| — | Mirror reconciler catches up after arbitrary crash sequence (F11) | **Property** | `packages/mirror/test/reconcile.prop.ts` |
| — | Search visibility scoping — no internal-block leak (F17) | **Property** | `packages/search/test/visibility-scope.prop.ts` |
| — | Audit + CRDT commit in one DB tx (F31) | **Property** | `packages/dispatcher/prop/writepath-atomicity.test.ts` — under fault injection at every in-tx query position, the five-row commit (`docs` + `doc_updates` + `outbox(doc.updated)` + `audit_events` + `outbox(audit.appended)`) is all-or-none across cold + warm code paths. The test does not assert a per-seq audit↔update foreign-key linkage; the schema does not carry one. (Landed P3.6e commit 2.) |
| — | Delegator revocation closes agent sessions (F43) | **Property** | `packages/sync/test/delegator-revocation.prop.ts` |
| — | Revocation survives Redis partition (F49) | **Property** | `packages/sync/test/revocation-redis-partition.prop.ts` |
| — | Outbox poller HA — exactly-once forward (F40) | **Property** | `packages/jobs/test/outbox-ha.prop.ts` |
| — | Webhook URL SSRF rejection (F46) | **Property** | `packages/webhooks/test/url-validation.prop.ts` |
| — | Webhook HMAC over raw body bytes — verify-before-parse (F62) | **Property** | `packages/webhooks/test/webhook-hmac-canonical.prop.ts` |
| — | Diagnose bundle redacts content by default (F47) | **Property** | `packages/admin/test/diagnose-redaction.prop.ts` |
| — | Secret rotation dual-accept window (F35) | **Property** | `packages/config/test/secret-rotation.prop.ts` |
| — | Concurrent secret rotation serialized (F60 + F79) | **Property** | `packages/config/test/concurrent-rotation.prop.ts` |
| — | Reconcile rejects foreign block IDs (F44) | **Property** | `packages/docs/test/reconcile-foreign-ids.prop.ts` |

### 17.1a SQLite load-ceiling validation (F48)

Phase 3 entry requires a measurement pass against ADR 0007's declared SQLite envelope. The test runs realistic write-path load for ≥ 10 minutes:

- 500 updates/sec across a 10-doc hot set,
- 100 jobs/min enqueue + consume,
- outbox poller at 250 ms tick,
- audit writer on each exercised mutation path.

Assertions:

- p99 write-path latency `< 1s` at the declared ceiling.
- Checkpoint-pause tail latency measured; tune `wal_autocheckpoint` (currently 1000; consider 10000) and `synchronous` mode tradeoffs.

If the ceiling is not met, **revise ADR 0007's SQLite envelope downward** — the admin dashboard's migration-nag threshold moves with it. Results committed under `packages/db/test/sqlite-ceiling.report.md`.

### 17.2 Nine-level stack (AGENTS.md)

1. **Types** — `tsc --noEmit` across monorepo (pre-commit).
2. **Lint + format** — Biome (pre-commit).
3. **Unit** — Vitest / Bun test; per package (pre-commit affected-only).
4. **Property** — fast-check; invariants above (pre-push for full fuzz).
5. **Integration** — capabilities against real SQLite + real Postgres (pre-push). Covers the Atlas Pro analyzers we don't pay for (ADR 0007).
6. **Contract** — API/CLI/MCP/UI parity matrix; generated, fail on drift (pre-push).
7. **E2E** — Playwright with `@axe-core/playwright` WCAG 2.1 AA (pre-push).
8. **Smoke deploy** — `docker compose up`; `GET /health`; create/read a doc; teardown (pre-push).
9. **Observability check** — traces export; no unexpected error spans (pre-push, budgeted).

Pre-commit fast lane: 1–3 + affected-only 5/6. Pre-push full lane: all nine. A commit that fails any step is blocked at the hook.

### 17.3 Eval harness (search)

Held-out 200-query set with judged-relevant docs (ADR 0008). nDCG@10 regression > 2 points blocks the PR.
