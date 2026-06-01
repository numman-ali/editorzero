# ADR 0017 — Soft-delete and recovery semantics

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

> **Amended by [ADR 0040](0040-tenancy-ia-model.md) (2026-06-01).** Model B adds **Space** as a deletable container between workspace and collection. Per this ADR's non-cascading container rule, `space.archive` **refuses on live descendants** (like `collection.delete` — surfacing a `HasLiveDescendantsError` counts payload); it does **not** cascade, and `space.restore` is the 1:1 inverse with one audit row each. `grants` / guest-grants carry **no `deleted_at`** — revoke is a hard `DELETE`, and grant rows ride with their resource through soft-delete, so a delete→restore cycle recovers the exact grant set without a preimage (state-as-of-delete). A cascading Space delete, if ever wanted, is a separate explicitly-designed capability with its own inverse story.

## Context
The Phase 0 brief claimed "soft-deletes are recoverable; hard deletes are separate and audited." Red-team (#16) flagged that "recoverable" is underspecified: over what window? across which entity types? with which cascade rules? Can a doc be restored if its parent workspace was hard-deleted? An invariant the test harness must actually verify.

## Decision

### Recovery window
- **Default:** 30 days from soft-delete.
- **Operator-configurable** per workspace (`workspace.trash_retention_days`, bounded [7, 365]).
- **Per-entity:** docs / blocks / comments / attachments use the same window; workspaces use a longer window (90 days) because workspace deletion is exceptional.

### What gets soft-deleted (cascade on doc delete)

When a doc is soft-deleted:
- `docs.deleted_at` set; doc disappears from normal listings / search / feeds.
- `blocks` of the doc: **preserved as-is**, with `parent_doc.deleted_at` implying their soft-delete transitively. No per-block flag; they live as long as the doc does.
- `doc_snapshots` and `doc_updates` (ADR 0007): **preserved unchanged** — CRDT state is needed for restore.
- `comments` on the doc: **preserved** with a derived-deleted flag visible to operators.
- `attachments` referenced by the doc: **preserved**; cleanup only happens after hard-delete + GC window.
- `search index entries`: **removed immediately** (so search doesn't surface dead docs); rebuilt on restore via ADR 0014 job.
- `embeddings`: **preserved** (marked inactive); re-activated on restore without recomputing.
- `audit_events` referencing the doc: **never deleted**.
- `webhooks` / `notifications` in flight for this doc: **cancelled**.

### What gets soft-deleted (cascade on workspace delete)

- All docs in workspace soft-delete.
- All principals (agents) bound to workspace: sessions terminated; tokens revoked; principal rows marked `deleted_at`.
- Custom domains bound to workspace: unregistered from Caddy (no more cert renewals); `custom_domains.deleted_at` set.
- Audit events: never deleted.
- Quota counters frozen at delete time for recovery.

### Restore

Restore is a capability (`doc.restore`, `workspace.restore`) with `requires: ["doc:delete"]` — same permission as the delete. Restoring a doc:
1. Clears `docs.deleted_at`.
2. Re-enqueues a search-index rebuild job (ADR 0014).
3. Re-activates embeddings for the doc.
4. Unprocesses the cancelled notifications (does not refire them — cancellation is terminal).
5. Emits `doc.restored` audit event.

Restoring a workspace:
1. Clears `workspace.deleted_at`.
2. For each soft-deleted doc in the window: leaves as-is (user restores docs individually from trash).
3. Re-registers custom domains within the window; certs that expired during deletion are re-issued on next access.
4. Agent tokens are NOT automatically reissued; human operator decides per-agent.

### Hard-delete

A separate capability (`workspace.purge`, `doc.purge`), `admin`-scoped. Executes a synchronous purge job:
- All doc-scoped rows deleted.
- `doc_snapshots` + `doc_updates` dropped.
- Attachments' blob storage entries deleted.
- Audit events **preserved** — the audit log is forever.
- A `purge_event` written to audit with the operator, the doc/workspace ID, and a one-time restore token (valid for 24h, for reversing accidental purges).

### GC

A reaper runs nightly (ADR 0014 cron):
- For each entity past its recovery window, hard-delete.
- Runs in smaller batches to avoid long DB locks.
- Logs each purge to audit.

### Inverse-restore property test (red-team #16)

Phase 3 harness includes a property test:

> For every soft-delete-and-restore cycle within the recovery window, the entity and its cascaded dependents return to a state bit-identical to the pre-delete state modulo `audit_events`.

Fuzz against docs of varying sizes and cascade shapes. Inverse-restore is the invariant that gives users durable trust in the trash.

## Consequences
- Users can recover accidentally-deleted content for 30 days by default.
- Hard-delete exists, is audited, and has a 24h grace escape.
- Audit log is never truncated — forensic integrity preserved.
- Search and notifications degrade gracefully on delete and restore.
- The inverse-restore property test gives us confidence the semantics hold.

## v1 implementation scope (2026-04-20)

The first `doc.delete` + `doc.restore` capability slice lands the **relational liveness flip** only:

- `doc.delete` UPDATEs `docs.deleted_at = now` + bumps `visibility_version` (public-route cache invalidation, architecture.md §5.4). Handler returns 404 on already-deleted — idempotent state arrival is not idempotent operation, and re-deleting would slide the 30-day recovery-window anchor.
- `doc.restore` is the inverse flip with the same version bump. Handler returns 404 on already-live (no no-op audit rows).
- Capability id `doc.delete` → audit effect kind `doc.soft_delete` (the `soft_` prefix distinguishes from `doc.purge` for forensic readers).
- Both capabilities are on the metadata-only lane (`METADATA_ONLY_CAPABILITIES` in `packages/scopes` widened accordingly; architecture.md §6.5 + §5.4 + Appendix C 7b/16 updated in lockstep). No Y.Doc touching, no `doc_updates` row.

**Cascade side-effects deferred.** The cascade listed under §"What gets soft-deleted (cascade on doc delete)" (search-index removal, embedding deactivation, notification cancellation, custom-domain unregistration on workspace delete) requires backing systems that are not in the tree yet (search index, embeddings, notifications, Caddy proxy orchestration). Cascade jobs attach as post-commit consumers of the `outbox` rows the metadata-only write-path already emits (the relevant queue names — `search_reindex`, `restore_search`, `dcr_cleanup` — are already reserved in `packages/scopes` → `QUEUE_NAMES`). No change to the v1 handler shape when they land — purely additive.

**Workspace-level + hard-delete deferred.** `workspace.delete` / `workspace.restore` / `workspace.purge` / `doc.purge` all sit post-Phase-3 — no runtime systems exist yet that need their cascade semantics. The 30-day recovery-window reaper (ADR 0014 cron `reaper` queue) is future.

**Inverse-restore property test status.** Still OPEN (Phase 3 harness). The current unit tests assert the relational flip + version bump; the property test's stronger claim — "bit-identical state modulo `audit_events` across delete→restore under fuzzed sizes + cascade shapes" — lands once blocks and doc_updates have adapter-driven mutation flows beyond `doc.create`'s seed.

## Revisit triggers
- A compliance requirement mandates immediate purge for specific classes of data (e.g., GDPR "right to erasure" for PII) — carve out a distinct purge path that still audits who executed it.
- Storage cost of retained-but-invisible CRDT state becomes material at scale — introduce snapshot-only retention for trashed docs.
- A user scenario requires longer-than-365-day retention; introduce legal-hold.
