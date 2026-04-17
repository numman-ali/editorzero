# Red-team pass #3 on `docs/architecture.md`

**Date:** 2026-04-17 → 2026-04-18 (pass spanned midnight)
**Target:** `docs/architecture.md` after pass-2 fixes (F31–F53) applied.
**Reviewers:** Opus sub-agent (F54–F72) + Codex independent pass (renumbered F73–F84 to dedupe).
**Disposition author:** @numman via primary agent.

## Context

Two prior passes had been applied: pass-1 produced F1–F30 (all applied), pass-2 produced F31–F53 (all applied). The architecture had grown from ~1587 lines (post pass-1) to 2061 (pre pass-2) to 2434 (post pass-2). Pass-3 was run to catch issues the pass-2 edits introduced, cross-section coherence drift, and anything the first two passes missed. For pass-3, @numman specifically requested a cross-model red-team: Opus sub-agent + Codex, independent prompts, simultaneous.

## Summary

Opus returned 19 findings (3.5/5 rating, "implementable with real operational edges"). Codex returned 12 findings (3.5/5 rating, "seam problems and adjoining-doc staleness"). After dedup, **25 unique findings** — **3 BLOCKER, 10 HIGH, 10 MEDIUM, 2 LOW**. Cross-model review paid for itself: Codex caught three things Opus missed that would have shipped broken (invalid Postgres SQL in §6.4, HA outbox lost-event regression, stale ADRs 0006/0018), and Opus caught several things Codex missed (`CapabilityContext.transact` type, `doc.rename` misclassification, SSRF IPv4-mapped-IPv6 bypass).

## Numbering convention for this pass

- **F54–F72** = Opus findings.
- **F73–F84** = Codex findings (renumbered from Codex's C54–C65 to avoid collision).
- Overlap marked in the disposition table; resolution keeps the stronger version and cross-references.

## Disposition

| ID (origin) | Severity | Title | Disposition | Notes |
|---|---|---|---|---|
| F66 (Opus) / F73 (Codex) | **BLOCKER** | `state_vector_at_fetch` cannot reconstruct historical state | **Accepted → Applied (merged)** | Replaced with opaque server-issued `reconcile_base_token`. New §3.18 `reconcile_bases` table; §6.6 rewritten; TTL = `max(72h, tombstone_floor)`; reaper batch `"reconcile_bases"` added. Codex's framing (whole contract unimplementable) prevailed over Opus's ergonomics framing. |
| F74 (Codex) | **BLOCKER** | HA outbox lost-event regression | **Accepted → Applied** | §6.3 and ADR 0014 rewritten: claim + `boss.send` in one Postgres tx; rollback on enqueue failure un-claims. Pass-2's F40 wording caused this regression; fixed cleanly. |
| F75 (Codex) | **BLOCKER** | `SELECT max(seq) FROM doc_updates FOR UPDATE` is invalid SQL | **Accepted → Applied** | New `doc_counters(doc_id, next_seq)` table; row-lock replaces aggregate-lock. Lock ordering documented in §6.4. Gapless-seq property test `doc-updates-gapless.prop.ts` added to §17.1. |
| F76 (Codex C56) | HIGH | ADRs 0006 and 0018 describe pre-F31 ownership | **Accepted → Applied** | Both ADRs rewritten to match architecture.md §6.1–6.3 single-tx semantics. Terminology unified. "Updated 2026-04-17" note at top of each. |
| F55 (Opus) | HIGH | `CapabilityContext.transact` callback type wrong | **Accepted → Applied** | Signature changed to `BlockNoteEditor<BlockSpecSchema>` (the primitive that actually exposes mutation methods). §16.4, §10.6, ASCII diagram updated. |
| F54 (Opus) | HIGH | `doc.rename` misclassified as metadata-only | **Accepted → Applied** | Removed from metadata-only set in §6.5; spec as standard CRDT-content mutation via `editor.updateBlock(titleBlockId, ...)`. AGENTS.md invariant 7 enumeration updated. |
| F56 (Opus) | HIGH | Webhook CRUD capabilities missing | **Accepted → Applied** | Appendix A gains `webhook.create/update/list/get/delete/test_delivery/rotate_secret`. Matching `AuditEffect` variants added. |
| F57 (Opus) | HIGH | Attachment multi-step missing from Appendix A | **Accepted → Applied** | Replaced `attachment.upload` with `attachment.request_upload` + `attachment.confirm_upload`. Audit variants added. |
| F58 (Opus) | HIGH | `mirror.reset` dual semantics | **Accepted → Applied** | Split into `mirror.reset_state` (clear state + re-project) and `mirror.reset_auth` (revoke secret + disable). Both `humanOnly`. |
| F78 (Codex C57) | HIGH | Revocation event-key mismatch | **Accepted → Applied** | Session registry now indexed by `token_id`, `principal_id`, AND `acting_as_user_id`. `member.remove` emits per-token events + delegator event. ADR 0016 updated. |
| F79 (Codex C59) | HIGH | Secret cache vs live rotation contradiction | **Accepted → Applied** | §16.12 split: startup-only vs runtime-rotatable. Runtime kind behind versioned cache + Redis pub/sub invalidation. Concurrency control on `admin.secret_rotate` (singletonKey). |
| F80 (Opus F61 + Codex C60) | HIGH | Attachment orphan cleanup (merged) | **Accepted → Applied** | New §3.10b `pending_uploads` table + 10m TTL + reaper batch. Server-side copy from temporary to final content-addressable key at confirm. Property test added. |
| F59 (Opus) | MEDIUM | DR cert re-issuance storm | **Accepted → Applied** | §18.1 restore procedure adds Caddy data backup + 7-day renewal-window note + `EDITORZERO_DR_MODE` bypass flag with 24h elevated cap. |
| F60 (Opus) | MEDIUM | Secret rotate concurrency | **Accepted → Applied** | Covered by F79 scope; `concurrent-rotation.prop.ts` added to §17.1. |
| F62 (Opus) | MEDIUM | HMAC canonical body unspecified | **Accepted → Applied** | §3.17 spells "raw UTF-8 bytes before any JSON parse/transform." Property test fuzzes non-ASCII + nested structures. |
| F63 (Opus) | MEDIUM | SSRF allowlist gaps (IPv4-mapped IPv6 etc.) | **Accepted → Applied** | Blocklist extended with CGNAT, 0.0.0.0/8, multicast, reserved, IPv6 unspecified, `::ffff:0:0/96` (IPv4-mapped). Prefer `ipaddr.js` category-based allowlist. |
| F64 (Opus) + F81 (Codex C64) | MEDIUM | PII cross-tenant correlation + missing fields | **Accepted → Applied (merged)** | §9.7 uses `HMAC-SHA256(per_workspace_salt, content)`; salt stored in `workspaces.diagnostic_salt`, rotatable. Redaction set extends to `filename`, `domain`, audit `email`. |
| F65 (Opus) | MEDIUM | Reconcile ergonomics cliff | **Resolved by F66/F73** | Opaque token means simple HTTP agents just pass the string back; no Yjs state-vector production needed. Noted in §6.6. |
| F67 (Opus) | MEDIUM | Re-auth stampede at minute boundary | **Accepted → Applied** | §10.3 uses uniform-random [8,12] min window. Metric + alert on `qps > 3× baseline`. |
| F68 (Opus) | MEDIUM | Seq retry cascade under contention | **Accepted → Applied** | §6.4 explicit: Hocuspocus per-doc serializer queues writers serially. Phase 3 load test bounds observed retry count. |
| F69 (Opus) | MEDIUM | Compaction vs onChange serialization implicit | **Accepted → Applied** | §6.4 documents per-doc lock spans both; gaplessness of seq proven by `doc_counters` increment being co-tx with `doc_updates` INSERT. Property test added. |
| F70 (Opus) | MEDIUM | Appendix C missing Phase 3 entry checks | **Accepted → Applied** | Added items 10–15: HNSW preflight, ADR 0018 smoke test, write-path crash-fuzz, reconcile-base-token flow, Redis-partition revocation, SQLite load ceiling (confirm). |
| F71 (Opus) | MEDIUM | Magic-byte offset spec ambiguous | **Accepted → Applied** | Per-content-type rule table in §3.10a; read 32 bytes; use `file-type` allowlist. |
| F82 (Codex C62) | MEDIUM | Invariant 7 enumeration drift across docs | **Accepted → Applied** | Unified list: `block.set_visibility, doc.publish, doc.unpublish, doc.move, collection.*`. AGENTS.md + §6.5 + §17.1 aligned. |
| F83 (Codex C63) | MEDIUM | Webhook DNS pin has no schema support | **Accepted → Applied** | Added `resolved_ip`, `resolved_at`, `resolution_policy` columns to §3.17 webhooks table; spelled out update + refresh rules. |
| F84 (Codex C65) | MEDIUM | §18 `pg_dump` nightly contradicts §18.1 WAL+PITR | **Accepted → Applied** | §18 rewritten: WAL archiving is the primary backup; `pg_dump` demoted to secondary export. Coordination window defined against WAL-snapshot point. |
| F72 (Opus) | LOW | Deprecated capability matrix rule | **Accepted → Applied** | §5.5.2 gains suppression rule (d): post-sunset capabilities drop from matrix; snapshot diff flags removal for reviewer. |

## Cross-model reconciliation commentary

Opus and Codex converged on the reconcile-contract problem (F66/F73) but framed it differently. Opus classed it MEDIUM with ergonomics fixes; Codex classed it BLOCKER with "whole contract unimplementable." Codex was right — state vectors don't reconstitute historical state; once tombstones sweep old `doc_updates`, the materialization primitive the spec assumed doesn't exist. The `reconcile_base_token` design resolves both framings: it's a real server-retained reference (Codex's need) and it's opaque-string ergonomic (Opus's need).

The three Codex-only BLOCKERs (F73/F74/F75) would have shipped broken without a cross-model pass. The `SELECT max() FOR UPDATE` invalidity is a particularly clean demonstration: Opus validated the fix at concept level; Codex checked whether the SQL is legal. Different models, different checks.

The Opus-only finds centered on engineering-primitives coherence (CapabilityContext type, metadata-only enumeration, SSRF IPv4-mapped-IPv6, magic-byte offset) — closer-to-code precision that comes out of an engineering-primitives-heavy architecture section.

## Should we run a pass-4?

No. Pass-3's findings are predominantly seam fixes and registry drift, not new architectural gaps. Pass-4 against a freshly-synced document would mostly rediscover the same minor-precision class already represented by F59/F62/F63/F67/F70/F71 etc. Better to lock Phase 2, scaffold Phase 3, and let implementation surface any remaining issues via actual code.

## What Phase 3 must prove (from these findings)

- Reconcile-base-token lifecycle (F66/F73): token valid + concurrent human edit → human wins; token expired → `stale_fetch`; token mid-compaction → still resolvable.
- Outbox one-tx claim+enqueue (F74): crash during enqueue leaves row unclaimed.
- Gapless seq via `doc_counters` (F75): retries produce no gaps.
- Write-path single-tx atomicity (F31 from pass-2, strengthened here).
- Secret rotation concurrency (F60/F79).
- Webhook HMAC fuzz (F62).
- SSRF blocklist correctness (F63) including IPv4-mapped IPv6.
- PII-redaction per-workspace-salt (F64/F81).
