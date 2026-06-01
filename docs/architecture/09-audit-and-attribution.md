## 9. Audit and attribution

### 9.1 Two precise invariants (was: one imprecise claim)

Red-team F1 + F21 established that "audit alone reconstructs state" is only true if *state* is defined narrowly. CRDT content is authoritative in `doc_snapshots` + `doc_updates` (ADR 0007); no amount of audit metadata can replay a Yjs transaction byte-for-byte. We therefore split one fuzzy claim into **two precise invariants**, each with its own property test.

**Definition — `PersistentWorkspaceState(W, T)`** is the tuple of these rows for workspace W at time T, in their canonical forms:

```
workspaces, workspace_members,
collections, docs (all columns EXCEPT projected fields: title, updated_at),
doc_versions,
comments (all columns),
attachments, attachment_refs, attachment_pinned_refs,
doc_acls, collection_acls,
agents, mirror_configs, custom_domains,
audit_events (itself).
```

Explicitly **out of scope** (derivable from above + CRDT or external input; covered by their own invariants, §17): `blocks` projection, FTS / vector indexes, `jobs` queue, `doc_snapshots`, `doc_updates`, Better Auth tables, Redis state, Caddy certs.

#### Invariant 3a — Audit replays persistent state

> For any workspace W and any T: `foldl(apply, ∅, audit_events[workspace_id=W, created_at ≤ T, outcome="allow"])` ≡ `PersistentWorkspaceState(W, T)`.

Proven by `packages/audit/test/replay.prop.ts`: fuzz N random workspace histories; for each, reconstruct PersistentWorkspaceState from audit alone; diff against live. Exhaustive over `AuditEffect` `kind` values — any new variant without a replay reducer is a compile error (§16.3 `audit-effect-exhaustiveness` lint).

> **Status correction — see [ADR 0040](../adr/0040-tenancy-ia-model.md) (2026-06-01).** This proof is **aspirational, not yet built**: `packages/audit/test/replay.prop.ts`, the replay reducer / `apply()`, the `PersistentWorkspaceState` builder, and the `audit-effect-exhaustiveness` lint **do not exist in the tree today** — invariant 3a is currently unproven for the *existing* model, not just for Model B. ADR 0040 sequences building this proof engine against today's ~50 effect kinds **first** (its Step 2), as a hard gate before any ACL effect lands. When Model B's tables land, the tuple above gains `spaces`, `space_members`, and `grants` **in the same commit** as the tables (replacing the `doc_acls`/`collection_acls` line — those tables are superseded by `grants`), or invariant 3a silently stops meaning "audit reconstructs ACL + membership state."

#### Invariant 3b — CRDT state is reproducible from snapshots + updates

> For any doc D and any snapshot_seq S: applying `doc_snapshots[D].latest_before(S)` followed by `doc_updates[D, seq ∈ (snapshot_seq, S]]` in seq order produces a Y.Doc equal to the live Y.Doc after every accepted update ≤ S.

Proven by `packages/sync/test/crdt-durability.prop.ts`: fuzz N random update sequences; checkpoint; simulate crash; rehydrate; diff.

Together 3a + 3b reconstruct the full workspace state. Neither alone is sufficient; both hold.

### 9.2 `AuditEffect` is load-bearing for invariant 3a

Effects must be **sufficient to replay the persistent-state change**, not merely sufficient to identify it. Red-team F1 demanded explicit fixes:

- `block.*` effects that mutate projected state carry the full post-projection block JSON *on top of* the CRDT update (which is the authoritative store). The audit reducer for projected-state rebuilds `blocks` row from the effect; the CRDT content itself is a separate invariant (3b).
- `doc.purge` carries the full **preimage** of the doc — not just a sha256. The purge effect's body includes the block array projection and the snapshot_seq at purge time, which together feed the 24h restore-token escape hatch (ADR 0017 §hard-delete).
- `block.update` effects use `post` (full block JSON after the update) — not `patch`. Patches can't be composed deterministically across fuzz fixtures; full post-state can.

The precise `AuditEffect` discriminated union lives in [§16.3](16-engineering-primitives-for-agentic-workflows.md#163-typed-primitives).

### 9.3 One row per accepted mutation; collapse only for reads (F2 fix)

Red-team F2 correctly flagged that "exactly one row per mutation" and "same-input rows collapse" cannot both hold for mutations. Resolution:

- **Every accepted capability invocation with `category = "mutation"` produces exactly one `audit_events` row**, with `collapsed_count = 1`. Collapse is **forbidden** for mutations — enforced by a dispatcher assertion and a contract test.
- **Collapse applies only to `category = "read"` invocations** where `collapseKey(input)` matches the prior row within 1s. A flooded agent running identical read calls gets collapsed rows (`collapsed_count += 1`) rather than 1000 near-duplicate rows.
- **Auth / denial rows never collapse.** Every `outcome = "deny"` row is its own row regardless of input equivalence — denial is forensically valuable.

**Single-tx semantics (F31).** For any accepted **content mutation** (a `category = "mutation"` invocation that traverses `ctx.transact` — i.e. is *not* in `METADATA_ONLY_CAPABILITIES`), the `doc_updates` row and the `audit_events(outcome="allow")` row commit in the **same DB transaction** alongside their respective `outbox` rows. There is no ordering in which a `doc_updates.seq=N` exists without an accompanying allow-audit row from the same transaction, and none in which the allow-audit row exists without the `doc_updates` row from the same transaction. The pair is not joined by an `audit_events` foreign key on seq (the schema does not carry one); the invariant is held by the single-DB-transaction commit boundary. A crash-fuzz property test (§17.1) asserts the all-or-none commit of the five-row tuple (`docs` + `doc_updates` + `outbox(doc.updated)` + `audit_events` + `outbox(audit.appended)`) under fault injection at every in-tx query position. **Metadata-only mutations** (`block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.delete`, `doc.restore`, `doc.move`, `collection.*`) follow the same single-tx discipline against a different tuple. At the trunk composition root (`packages/api-server/src/composition/createApiDispatcher.ts`) the full tuple lands transactionally: the relational metadata write(s) the capability owns (e.g. `block.set_visibility` updates `blocks.visibility` + `docs.visibility_version` per §3.6 and §5.4 — capability-specific) **plus** capability-specific handler-emitted `ctx.outbox(...)` rows (e.g. `doc.publish` / `doc.unpublish` emit `doc.visibility_changed`; queued during the handler invocation and flushed by `createOutboxWriter().append(auditTx, …)` before the tx commits) **plus** `audit_events(outcome="allow")` **plus** `outbox(audit.appended)` commit together in the dispatcher's `withSystemTx`, or none. The dispatcher-package's own test fixtures under `packages/dispatcher/{src,prop}/` still pass `ctx.outbox(...)` as a no-op stub — those tests verify dispatcher semantics in isolation and are not the trunk contract. **Metadata-only atomicity is fully closed — implementation + verification both landed at the trunk.** The N-way fault-injection property test at `packages/api-server/prop/metadata-only-atomicity.test.ts` (§17.1 row 7b) asserts the all-or-none commit of the four-row tuple under fault injection at every in-tx query position, exercising the real `createApiDispatcher` factory via a plugin-wrapped driver. The F31 content-mutation crash-fuzz does not exercise the metadata-only path because there is no `doc_updates` row whose absence to assert; the metadata-only fuzz is the symmetric closure for that tuple.

**Outcome → row shape (F32).** Every `audit_events` row carries an `outcome` and an `effect` keyed by outcome:

- `outcome="allow"`: `effect` is an `AuditEffect` variant (§16.3); replay reducer consumes it.
- `outcome="deny"`: `effect` is an `AuditDeny` variant capturing `capability`, `required_scopes`, `reason_code`. `audit_events.deny_reason` is a denormalized column populated from `AuditDeny.reason_code` so per-reason queries are indexable without JSON extraction.
- `outcome="error"`: `effect` is an `AuditError` variant capturing `capability`, `error_code`, `retriable`.

The replay reducer for `PersistentWorkspaceState` (invariant 3a) ignores `deny` and `error` rows; the `audit-effect-exhaustiveness` lint (§16.8) is satisfied because every `AuditRecord` variant has a branch (even if the branch is a no-op).

Rate limit on audit writes (unchanged from ADR 0009): per-principal 1k/min sustained, burst 3k. Sustained overflow > 5 min → principal suspended (circuit-break). Never silently drop.

### 9.4 Attribution

Every row carries:

- `principal_kind` + `principal_id` — who acted.
- `acting_as_user_id` — if agent, which human delegator.
- `session_id` — WebSocket / HTTP session.
- `token_id` — which credential (supports per-token revocation forensics).
- `trace_id` — OTel trace for cross-service correlation.

A support ticket "who edited block X at 14:03" narrows to a specific `(agent, owning_human, session, token)` tuple, not just "a user."

### 9.5 Query discipline — always filter on `subject_kind` (F26 fix)

`audit_events.subject_id` is `TEXT` and stores IDs from disjoint ID spaces (UserId, AgentId, DocId, …). UUIDv7 collision is negligible but not zero across independently-generated spaces. Queries that filter on `subject_id` alone are a latent bug.

- Repository interface `auditRepo` exposes `findBySubject(kind: SubjectKind, id: string)` — the one way in.
- Lint rule `no-raw-audit-events-query` (§16.8) forbids direct Kysely access to `audit_events` outside `packages/db/repos/audit.ts`.
- Admin-dashboard queries go through the same repo.

### 9.6 Retention

Audit is never truncated. Operators export a workspace's audit as JSON-Lines via `admin.diagnose --audit --workspace=X`. Export is an admin-scoped capability; the export itself audits.

### 9.7 PII in telemetry and support bundles (F47 + F64)

Support bundles and exported logs must not leak user / doc content by default. Redaction applies in two places:

- **`admin.diagnose` bundle output.** Audit effects that carry content fields are redacted to **HMAC-SHA256 hashes keyed by a per-workspace diagnostic salt** before export (F64). The salt is `workspaces.diagnostic_salt` — generated at workspace creation, rotated on `admin.secret_rotate --kind=diagnostic_salt`. The redaction set (extended per F64):
  - Any field inside `doc.update_batch` ops (`block.content_json`, `content_text`).
  - `block.insert.post`, `block.update.post`.
  - `comment.create.body_markdown`, `comment.update.body_markdown`.
  - `doc.rename.title`, `doc.publish` title-like fields.
  - **`attachments.filename` (F64).**
  - **`custom_domains.domain` (F64).**
  - **Audit attribution `email` fields (F64) — any Better-Auth-sourced `email` joined into the bundle.**
- **Log / span export.** The OTel redaction processor strips span attributes with these keys before export: `content_text`, `block.content`, `title`, `comment.body`, `attachment.filename`, `custom_domain.domain`, `email`. The span attribute `redacted_keys: string[]` records which keys were stripped, preserving shape for debugging.

**Why HMAC with per-workspace salt, not plain sha256.** A plaintext sha256 is a stable identifier across tenants — two workspaces that both contain "Project Atlas" would collide on the hash, enabling cross-tenant correlation in shared support logs. HMAC keyed by a per-workspace salt breaks the collision: the same plaintext in different workspaces hashes to different values. The salt is never exported in the bundle. Property test `diagnose-redaction.prop.ts` extended: "no unsalted stable identifiers for user content or tenant identity appear in any export."

**Escalation.** An operator who needs raw content for a real incident passes `--with-content` (and equivalent API input) to `admin.diagnose`. Guard rails:

- **Per-workspace co-sign required.** The admin invoking must hold `admin` scope on **every workspace included in the bundle**; missing any → `PermissionDeniedError`.
- **Distinct audit event.** Each `--with-content` export emits an `audit.diagnose.with_content` row recording invoker, workspaces, timestamp, and the exact fields un-redacted. Investigators can query "who ever pulled raw content" without replaying the whole bundle.

Property test (`diagnose-redaction.prop.ts`): default `admin.diagnose` output contains zero raw block content — every content-bearing audit row in the bundle shows HMAC(salt, content) hashes, never plaintext. Assertion (F64): "no unsalted stable identifiers for user content or tenant identity appear in any export" — enforced by computing sha256(content) for each redacted field and asserting that value is NOT present anywhere in the bundle. Fuzz across the full `AuditEffect` union.
