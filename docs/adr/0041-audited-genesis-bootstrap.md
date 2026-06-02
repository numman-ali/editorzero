# ADR 0041 — Audited genesis bootstrap via system-audit provenance markers

**Status:** Accepted (new, 2026-06-02)
**Date:** 2026-06-02
**Deciders:** @numman, Claude Opus 4.8 (with a cross-model Codex peer review of the seam)

## Context

Invariant 3 (AGENTS.md; architecture §9.1 invariant 3a) is absolute: **every mutation produces exactly one audit entry, and the audit log alone reconstructs final persistent state.** The replay reducer landed (ADR 0040 build-order step 2; `packages/audit`) is its proof engine — it folds `audit_events` into a `PersistentWorkspaceState` that must deep-equal the live DB projection.

There is one mutation the live system performs that emits **no** audit row: **genesis bootstrap.** On signup, `create-auth.ts`'s `user.create.after` hook writes two durable rows via `driver.system()` — the `workspaces` tenant anchor and the owner `workspace_members` row (ADR 0024 §4) — entirely outside the dispatcher. These rows create the root workspace authority and the first owner. A replay from `audit_events` therefore reconstructs **nothing** for the workspace and its owner: invariant 3 is violated precisely for the state that confers all authority.

Codex's effect→state contract pass (the review behind ADR 0040 step 2 / the #25 fix-forward) flagged this as HIGH 2. The replay engine's own contract docstring already names the gap. The question this ADR settles: **does genesis stay an explicit non-audited exception, or is it audited?**

The genesis writes do not flow through a `Capability`. They have no dispatch context — no scopes, no `PermissionGate`, no `ctx`. So if they are to be audited, the audit row needs a `capability_id` that is **not** a registered, dispatchable capability.

## Decision

**Audit genesis. Do not carve it out.** A signup is a runtime domain mutation that creates durable authority; if replay must seed that state from a side channel, invariant 3 degrades to "the log reconstructs final state *except the state that grants everyone authority*" — the wrong exception. The audit log stays the complete, sole source of truth.

Three parts:

### 1. System-audit provenance markers (`@editorzero/scopes`)

A new exported SSOT:

```ts
export const SYSTEM_WORKSPACE_BOOTSTRAP = "system.workspace_bootstrap";
export const SYSTEM_AUDIT_CAPABILITY_IDS = [SYSTEM_WORKSPACE_BOOTSTRAP] as const;
export function isSystemAuditCapabilityId(id: string): id is SystemAuditCapabilityId;
```

These are synthetic `capability_id` values that may appear on `audit_events` rows produced **outside** the dispatcher. They are **non-dispatchable**: no `Capability` carries one, they have no scopes/handler/surfaces, and they never appear in Appendix A. The `capability_id` is the **provenance label on the audit envelope, not a dispatch target.**

The `system.` prefix (rather than a `workspace.`-domain name) makes the provenance unmistakable — *system, not dispatch* — and cannot be confused with a dispatchable workspace capability. One marker (`system.workspace_bootstrap`) labels **both** genesis rows; they differ by `effect` (`workspace.create` vs `member.add`) and `subject`.

A **coherence check** (`scripts/coherence.ts`) enforces that `SYSTEM_AUDIT_CAPABILITY_IDS` is **disjoint** from the implemented capability ids (the `CapabilityId(...)` literals under `packages/capabilities/src/**`). A marker can therefore never silently become — or be shadowed by — a real capability. This is the "coherence-validated allowlist, not a bypass" guardrail: the marker is a first-class, enumerated, validated concept.

The set is reusable for the future import / repair-job markers those slices will need.

### 2. A dedicated system-audit transaction seam (not the dispatcher)

The genesis tuple commits via `driver.withSystemTx` (serializable; both drivers), reusing the **real** `AuditWriter` (`createAuditWriter` + `asAuditTx`, `@editorzero/db`) so the `audit_events` row shape — and its paired `outbox(audit.appended)` fan-out — stays single-sourced rather than hand-rolled:

```ts
await driver.withSystemTx(async (tx) => {
  const wsRow     = await tx.insertInto("workspaces").values(…).onConflict(doNothing).returning(["id"]).executeTakeFirst();
  const memberRow = await tx.insertInto("workspace_members").values(…).onConflict(doNothing).returning(["workspace_id"]).executeTakeFirst();
  if (wsRow)     await auditWriter.write(asAuditTx(tx), workspaceCreateRow);
  if (memberRow) await auditWriter.write(asAuditTx(tx), memberAddRow);
});
```

The audit row emits **only when its insert actually mutated** (the `onConflict().doNothing()` returns no row on a retry-collision), so a debounced re-signup reconverges rather than double-auditing — invariant 3's "exactly one entry per mutation" holds across retries.

### 3. Atomicity boundary — post-commit app bootstrap transaction

`user.create.after` fires **after** Better Auth's signup tx commits (verified: `queueAfterTransactionHook`). So `withSystemTx` makes the four writes (2 domain + 2 audit) atomic **among themselves**, but **not** with the already-committed Better Auth `user` row. This is an improvement over today's two bare post-commit inserts and is the correct boundary for this slice.

The pre-existing **user-without-workspace** gap (a crash after the `user` commit but before/within the bootstrap tx strands an orphan user) is **out of scope and unchanged**: the `onConflict().doNothing()` idempotency already covers a debounced retry, and the lever stays "signup throws → surface to UI → retry." Closing it fully (a reconcile job, or moving genesis into the user tx) is a separate slice.

## Consequences

- **Invariant 3 closes for signup.** `replay(audit_events)` reconstructs the genesis workspace + owner membership from the log alone. The integration property test (real dispatch → replay → DB compare) can include a freshly-bootstrapped workspace and expect equality without seeding.
- **Two `audit.appended` outbox events** fire at genesis (one per row) — by construction, since `AuditWriter.write` pairs every `audit_events` insert with an outbox row. The bootstrapped workspace/member are now observable domain events for downstream webhook/notification/projection consumers. This is a **feature**: genesis is a real domain event. If it is ever too noisy, the fix is subscription filtering, not suppressing the audit.
- **`member.add` carries no `created_by`.** The envelope principal (the signing-up user) plus the `role` are sufficient for replay and forensics; the `workspace_members` row has no such column. Inviter/invitation attribution, if it ever lands, is a different effect shape, not genesis's job.
- **A reusable seam.** Future non-dispatch system mutations (data import, repair jobs) get audited the same way — add a marker to `SYSTEM_AUDIT_CAPABILITY_IDS`, emit via `withSystemTx` + the real writer.

## Alternatives considered

- **Genesis as a documented non-audited exception** (replay seeds the root workspace). Rejected: makes invariant 3 conditional on the most authority-bearing state, and forces every replay consumer (property test, future projection/forensic tooling) to carry a special-case seed. The exception would metastasize.
- **A raw `capability_id` string on the row, no allowlist.** Rejected (Codex): an unvalidated string is silent drift — it could collide with a real capability or rot. The enumerated, coherence-validated marker set is the "not a bypass" form.
- **Route genesis through a real `workspace.create` capability dispatch.** Rejected: signup is not a dispatch context (no principal-with-scopes yet — the user is mid-creation), and a self-authorizing bootstrap capability would be a worse security seam than an explicit, enumerated system marker.
- **`workspace.bootstrap` (workspace domain) as the marker.** Rejected in favor of `system.workspace_bootstrap` (Codex): the `system.` prefix cannot be mistaken for a dispatchable workspace capability and states the provenance plainly.

## Review

Seam cross-reviewed by Codex (peer, 2026-06-02): converged on *audit, do not except*; preferred the `system.` prefix; specified the `withSystemTx` + `asAuditTx`-reusing-the-real-writer shape; and corrected the atomicity framing to *post-commit app bootstrap transaction* (atomic among the genesis tuple, not with the Better Auth user insert). All folded in.

Relates to: invariant 3; ADR 0024 (bootstrap hook); ADR 0040 step 2 + the #25 effect→state fix-forward (the replay engine this closes the genesis gap for); ADR 0018/0023 (`withSystemTx`, the write-path tx primitive).
