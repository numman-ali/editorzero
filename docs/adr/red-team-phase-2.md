# Red-team pass #2 on `docs/architecture.md`

**Date:** 2026-04-17
**Target:** `docs/architecture.md` after pass-1 fixes F1–F30 applied.
**Reviewer:** Opus sub-agent, independent of author context.
**Disposition author:** @numman via primary agent.

## Context

Pass #1 produced F1–F30 (see `red-team-phase-1.md`), all applied. The BlockNote re-validation research pass then surfaced an API-naming correction (`ServerBlockNoteEditor.transact()` → `openDirectConnection.transact(ydoc → BlockNoteEditor.create({ collaboration }).transact(...))`), fixed in ADR 0018 + ADR 0004. Pass #2 was spawned on the revised file to hunt for what pass #1 missed, what the revisions introduced, and any remaining under-specification — with explicit instruction not to re-flag the BlockNote API issue.

## Summary

23 findings — **3 BLOCKER, 7 HIGH, 9 MEDIUM, 4 LOW**. Overall assessment: 3.5/5 — coherent enough to scaffold Phase 3 against, but with real operational + security gaps (DR/RPO/RTO, secrets, webhooks, PII redaction, outbox HA, reconcile clobber-on-update) that will hurt once code lands. All findings accepted; fixes applied to `architecture.md`, `AGENTS.md`, ADR 0014, ADR 0016.

## Disposition — finding by finding

| ID | Severity | Title | Disposition | Notes |
|---|---|---|---|---|
| F31 | BLOCKER | Audit write not atomic with CRDT write | **Accepted → Applied** | §6.1/§6.2/§9.3 rewritten: single dispatcher-owned DB tx holds `doc_updates + audit_events + outbox*`. Added crash-fuzz property test to §17.1. |
| F32 | BLOCKER | `effectFrom` can't capture deny/error | **Accepted → Applied** | §4.1 capability shape split into `effectOnAllow / effectOnDeny / effectOnError`; §16.3 added `AuditDeny` + `AuditError` variants; §9.3 documents outcome-aware replay rules. |
| F33 | BLOCKER | `doc.update_batch` missing `move` op | **Accepted → Applied** | §16.3 `DocUpdateOp` union extended with `move`; §6.5 documents BlockNote-native move preservation; §6.6 reconcile emits `move` instead of `remove+insert`. |
| F34 | HIGH | No DR/RPO/RTO story | **Accepted → Applied** | New §18.1 "Disaster recovery" with declared RPO (15 min Postgres / 24h SQLite), RTO (30 min single-node / 2h HA), restore procedure, coordination window, tombstone constraint, `editorzero restore` CLI. |
| F35 | HIGH | Secret management unspecified | **Accepted → Applied** | New §16.12 "Secret management" — typed `SecretSource` union, at-rest encryption, `admin.secret_rotate` dual-accept-window lifecycle, webhook HMAC spec, mirror auth lifecycle. AGENTS.md gotcha added. |
| F36 | HIGH | Seq atomicity under HA invalid | **Accepted → Applied** | §6.4 rewritten: Postgres (`FOR UPDATE` + `UNIQUE(doc_id,seq)`), SQLite (`BEGIN IMMEDIATE` + WAL), HA manager-failover uses Redis lease + drain window. `manager.failover_count` metric. |
| F37 | HIGH | Reconcile clobbers concurrent updates | **Accepted → Applied** | §6.6 adds `state_vector_at_fetch` required input; `mode: reconcile \| replace \| strict`; default reconcile preserves human edits on conflict. Property test added. |
| F38 | HIGH | Residency policy breaks at scale | **Accepted → Applied** | §10.5 rewrite: per-process cap + horizontal scale math, default 50% process RAM, eviction decoupled from flush, `inactive_ttl` tiered, admin alerts. |
| F39 | HIGH | pgvector HNSW memory unspecified | **Accepted → Applied** | New §11.4 "Memory budgets"; preflight check in `admin.reembed_workspace`; surfaces index size on `/admin/observability`. |
| F40 | HIGH | Outbox poller HA duplication | **Accepted → Applied** | §6.3 adds singleton-poller election + atomic row-claim + `singletonKey = outbox.id` on pg-boss. ADR 0014 updated with HA-safe enqueue note. |
| F41 | MEDIUM | `set_visibility` bypasses invariant 7 | **Accepted → Applied** | §6.5 documents metadata carve-out; AGENTS.md invariant 7 amended to distinguish content vs metadata mutations. `transact-called-at-most-once` lint tolerates zero-call metadata capabilities. |
| F42 | MEDIUM | Contract-test combinatorics unbounded | **Accepted → Applied** | §5.5.2 formalizes matrix cell shape + suppression rules + metadata exclusion list; `contract-matrix.snapshot.json` committed + diff-reviewed. |
| F43 | MEDIUM | `acting_as` revocation undefined | **Accepted → Applied** | §10.3 adds `revoked-delegator` event path; session-registry indexed by `acting_as_user_id`. ADR 0016 updated with delegation revocation subsection. |
| F44 | MEDIUM | Reconcile ID-spoof hazard | **Accepted → Applied** | §6.6 contract: fabricated / mismatched-type IDs produce fresh IDs with diagnostic, never update existing blocks. Property test added. |
| F45 | MEDIUM | Attachment flow unspecified | **Accepted → Applied** | New §3.10a "Attachment lifecycle": signed-URL upload + scan + quota + allowlist. |
| F46 | MEDIUM | Webhook delivery unsafe | **Accepted → Applied** | New §3.17 `webhooks` table; §12 adds HMAC signing, replay protection, SSRF guards (DNS pin, no loopback/RFC1918), circuit-break. Property test. |
| F47 | MEDIUM | PII in `admin.diagnose` | **Accepted → Applied** | New §9.7 "PII in telemetry" — content redacted to sha256 by default; `--with-content` requires workspace-admin co-sign + distinct audit row. |
| F48 | MEDIUM | SQLite WAL contention | **Accepted → Applied** | §17 + Appendix C Phase 3 entry checklist adds SQLite load-ceiling validation; revisit-trigger for ADR 0007 if p99 breaches. |
| F49 | MEDIUM | Redis pub/sub revocation best-effort | **Accepted → Applied** | §10.3 adds `revocation_log` persistence path + 1s poller + periodic forced `onAuthenticate`; property test under simulated Redis disconnect. |
| F50 | LOW | Missing `AuditEffect` variants | **Accepted → Applied** | §16.3 extended with `admin.*`, `mirror.reset`, `custom_domain.verify` envelope variants — exhaustiveness lint satisfied. |
| F51 | LOW | `published_slug` scope note | **Accepted → Applied** | §3.5 notes v1 single-custom-domain-per-workspace invariant + forward migration path. |
| F52 | LOW | Event-loop lag budget undeclared | **Accepted → Applied** | §10.4 declares p99 < 50 ms budget; ADR 0006 revisit-trigger on sustained breach. |
| F53 | LOW | Proxy LRU HA invalidation | **Accepted → Applied** | §5.4 adds Redis pub/sub invalidation + 60s TTL safety net. |

## Grouping notes

- **F31 + F32 + F33** form one audit-integrity cluster. Fixes are coherent and mutually reinforcing: one-tx commit boundary + outcome-aware effects + move-op coverage means the replay reducer in §9 is now fully specified and property-testable.
- **F37 + F44** form the reconcile-safety cluster. The reconcile contract is now a three-mode API with explicit state-vector checking and ID-spoof defense.
- **F34 + F35 + F46 + F47** form the operational-posture cluster, collectively anticipating Phase 5 threat-model inputs.
- **F38 + F39 + F48** form the scale-ceiling cluster; all three will be re-validated in Phase 3 under load.

## Rebuttals

None. Every finding was accepted. In most cases the suggested fix was applied directly; in a few cases (F37 mode semantics, F44 ID provenance) the disposition expanded the fix shape to close adjacent gaps surfaced while editing.

## What pass #3 should hunt

Pass #3 is intentionally scoped to find what pass #2's revisions introduced, not to re-audit what pass #1 and pass #2 already covered. Likely hunting zones:

1. Coherence between the new §18.1 (DR) and the existing compaction/tombstone rules in ADR 0007.
2. Whether the single-tx F31 fix creates new deadlock surfaces between Hocuspocus `onChange`, the dispatcher-owned tx, and `onStoreDocument`.
3. Whether the new §3.17 webhooks table + §12 delivery semantics introduce any new audit gaps.
4. Whether the reconcile mode API (F37) + ID-spoof defense (F44) creates a surface that legitimate agents struggle to use (ergonomic regression).
5. Whether the §16.12 secret-management discipline is actually implementable without blocking Phase 3 kickoff.
6. Whether §16.3 `AuditEffect` is now large enough that the exhaustiveness lint becomes expensive / produces poor error messages.
7. Whether the new admin-* capability variants in Appendix A match scope/rate-limit profiles for a workspace-admin role that doesn't yet exist.
