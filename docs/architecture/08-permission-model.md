## 8. Permission model

### 8.1 Enforcement layers (ADR 0015; algebra + RLS amended by ADR 0040)

```
Layer 1 — Capability dispatch + ceiling resolver   [committed authority]
  dispatcher resolves Principal → evaluates requires →
  ceiling resolver decides reads AND mutations (never a graph walk):
    ( access_mode(doc)='space' ? Space-baseline-members(space)
                              : {created_by} )
      ∪ explicit grants ∪ guest grants        (positive-only roles)
  agentAllowed / humanOnly flags checked →
  scopes intersected (agent.scopes ∩ delegator.permissions when acting_as) →
  allow | deny (+ audit row for deny)
  The resolver is the SOLE read path for Space-scoped reads (lint-enforced).

Layer 2 — TenantScopedDb (Kysely wrapper + AsyncLocalStorage)  [committed floor]
  every query against a tenant-scoped table auto-injects
  workspace_id = ctx.workspace_id; build-time type error
  + runtime assertion if a TenantContext is missing.

Cross-backend equivalence — the cross-tenant/ceiling isolation fuzzer (§8.1a)
  asserts correct RESULTS (not merely zero rows) on BOTH SQLite and Postgres.

Layer 3 — Postgres RLS                         [TRIGGERED-FUTURE — not committed]
  Not built. Per ADR 0040 fork #4 it is NOT a committed layer: multi-tenant is
  a product non-goal and workspace_id-keyed RLS cannot guard the cross-Space
  boundary anyway. Add only if a raw-SQL / BI / external-query path appears.
```

Both backends run Layer 1 + Layer 2 — that is the committed enforcement floor, equal on SQLite and Postgres. Layer 3 (RLS) is a triggered-future option, not part of the shipped model.

> **Amended by [ADR 0040](../adr/0040-tenancy-ia-model.md) (2026-06-01).** ADR 0015 originally specified a *three-layer* model (capability + tenant plugin + Postgres RLS). Two changes, reflected affirmatively above: **(1) RLS is no longer a committed layer** (fork #4); the app-layer floor is the design. **(2) the Layer-1 algebra inverts** from the old most-permissive union (`role_default ⊕ workspace_override ⊕ collection_acls ⊕ doc_acls`) to the **ceiling** shown. **Build status (updated 2026-06-12, Step 6 LANDED):** the ceiling resolver is LIVE — `loadDocReadResolver` (`packages/capabilities/src/acl/ceiling.ts`, the sole read authority) gates `doc.get`/`doc.list` and all seven doc mutations via the F88 `acl_deny` channel, and `workspaceAwareGate` lands the `acting_as` ∩ delegator intersection (H8) at the composition root. Pre-Step-7/8 data reads as the workspace-legacy baseline (NULL-space ⇒ every workspace principal), so enforcement is live machinery with zero observable narrowing until Spaces populate. The §8.1a fuzzer exists at resolver grade (oracle-equality + H6 + privacy, 60 worlds/commit, mutation-tested); the full capability-matrix × dual-driver fuzz and the ACL-audit-replay property land with Steps 7/8 (no capability can mutate grants/spaces yet). The cross-tenant hard-deny (§8.3) is unchanged and orthogonal.

### 8.1a SQLite hardening — Layer-2-as-floor (F4 fix)

SQLite has no RLS. Layer 2 (`TenantScopedDb`) is the last line of defense. That's adequate only if Layer 2 is **actually unbypassable**, and that requires more than a wrapper — it requires:

- **Architecture lint rule `no-raw-kysely-outside-db`:** `Kysely`, `sql<T>` raw template, and `db.connection()` are importable only inside `packages/db/**`. Anywhere else, an import failure at pre-commit. Today this is enforced by `scripts/coherence.ts` via import-string grep; when `@editorzero/arch-lint` ships (F89) the rule moves to a proper static check, but the invariant is gated from day one. Capabilities and services reach the DB through `ctx.db` (a `TenantScopedDb`) or through `dbRepo.<method>` (which internally uses `TenantScopedDb`).
- **`OpsDb` escape hatch is opt-in, audited, and enumerated.** `OpsDb` is a distinct type that requires a `@ops-audited("reason")` decorator at the call site. The planned `ops-db-audit` rule in `@editorzero/arch-lint` will fail the commit on an un-audited construction once the package ships (F89 — not yet implemented; discipline + review today). Each legitimate use site is listed in `ops/ops-db-registry.md` with owner + rationale.
- **Cross-tenant leak fuzzer is a first-class invariant test.** `packages/db/test/tenant-isolation.prop.ts` runs against **both** SQLite and Postgres drivers: for every `(capability, principal_workspace, target_workspace)` combination, assert that no tenant-scoped row from `target_workspace ≠ principal_workspace` is reachable through any capability call. Default fuzz: 1k rounds per driver per commit; 100k nightly.
- **The fuzzer — not RLS — is the cross-backend guarantee.** RLS is not built (triggered-future, ADR 0040 fork #4); the isolation fuzzer's invariant is stronger than RLS anyway — it asserts the capability returns the **correct result**, not merely zero rows, identically on SQLite and Postgres.

The combination means "SQLite mode has no RLS" does not mean "SQLite mode has weaker tenant isolation." The fuzzer enforces equivalent behavior.

### 8.2 AccessPath shape (ADR 0015)

```ts
type AccessPath = {
  workspace_id: WorkspaceId;
  doc_id?: DocId;
  block_id?: BlockId;
  selector?: SubBlockSelector;   // reserved; always null in v1
};
```

Every capability handler receives an `AccessPath` in context. Policy evaluation short-circuits sub-block tier when `selector === null` — zero runtime cost.

### 8.3 Worked examples

#### (a) Cross-workspace read (denied)

Alice (workspace A member) requests `doc.get(doc_id=D)` where D is in workspace B.

1. Hono resolves Alice's session → `Principal{ kind: "user", id: Alice, workspace_id: A }`.
2. Dispatcher fetches `D.workspace_id = B`; `AccessPath.workspace_id = B` but `Principal.workspace_id = A`.
3. Layer 1 denies: `Principal.workspace_id ≠ AccessPath.workspace_id`. Audit row written with `outcome=deny`, `deny_reason="cross_workspace"`.
4. Layer 2 never reached. (If Layer 1 were bypassed, Layer 2's query would still scope to A and return empty — the committed two-layer floor; RLS, if ever triggered, would too.)

#### (b) Public publish strips internal blocks

Alice runs `doc.publish(doc_id=D)` on a doc with some `block.visibility='internal'` rows.

1. Dispatcher checks `Alice` has `doc:publish` on D. Allowed.
2. Handler: sets `published_at=now()` + `published_slug` (publish is orthogonal — `access_mode` is unchanged; ADR 0040). Enqueues `projection_blocks` job.
3. Published render path reads blocks WHERE `visibility != 'internal'` and is regenerated to static HTML by the outbox consumer (ADR 0027) — keyed on a composite (`visibility_version` + content-hash), served with `ETag`/`must-revalidate`, so the render is deterministic per snapshot.
4. Audit row on the publish itself; per-block visibility enforcement is not audited per-read (would flood the log).

#### (c) Agent-only API token

A workspace admin creates agent `Bot42` with scopes `[doc:read, doc:write, comment:write]`.

1. Admin runs `agent.create(workspace_id=A, name="Bot42", owner_user_id=Alice)`. Row written; Better Auth issues a key via `@better-auth/api-key` with `referenceId=A`, `permissions=["doc:read","doc:write","comment:write"]`, `rateLimitMax=5000/day`.
2. Bot42 calls `doc.update(doc_id=D, …)` using the key as bearer.
3. Auth middleware: key → `Principal{ kind: "agent", id: Bot42, workspace_id: A, scopes: [...], owner_user_id: Alice, token_kind: "api-key" }`.
4. Dispatcher: `requires=["doc:write"]` ∩ `Principal.scopes` = `["doc:write"]` — allowed. `humanOnly` flag? No. Rate-limit bucket `doc.write` on `Principal.id=Bot42` decremented.
5. Handler runs; audit row attributes `principal_kind=agent`, `principal_id=Bot42`, `acting_as_user_id=null` (not a delegated token).

#### (d) `acting_as` delegation

Bot42 uses an Agent Auth Protocol delegated token with `sub=Bot42, act.sub=Alice`.

1. Auth middleware produces `Principal{ ..., id: Bot42, acting_as: Alice, token_kind: "agent-auth" }`.
2. Dispatcher computes effective permissions as `intersect(Bot42.scopes, Alice.workspace_permissions)` — Bot42 cannot exceed Alice.
3. Rate limit: **both buckets** decremented (Bot42's and Alice's). Whichever is depleted first rate-limits.
4. Audit attributes `principal_kind=agent`, `principal_id=Bot42`, `acting_as_user_id=Alice`. Investigator sees both.

#### (e) Sub-block selector reserved

An agent attempts `doc.update` with a selector targeting a single cell in a table block. In v1:

1. `AccessPath.selector != null`. Policy evaluation currently rejects a non-null selector with `deny_reason="sub_block_acl_not_implemented"`.
2. Audit row captures the attempt. When sub-block ACLs ship, the policy grows a branch to evaluate selector; the error disappears for allowed selectors.

This makes the reservation observable — we can see whether agents hit the path in the wild before we build it.

#### (f) Soft-delete → restore

Alice soft-deletes doc D; 10 days later she runs `doc.restore(D)`.

1. Soft-delete: dispatcher checks `doc:delete`; handler sets `docs.deleted_at=now()`. Cascade per ADR 0017 §cascade. Audit row `doc.deleted`.
2. Restore: dispatcher checks `doc:delete` (same scope per ADR 0017). `docs.deleted_at=null`. `search_reindex`, `restore_search` jobs enqueued. Embeddings re-activated. Audit row `doc.restored`.
3. Inverse-restore property test (Phase 3) fuzzes D → delete → restore and asserts state equality modulo `audit_events`.

### 8.4 Default agent scope tiers (F14 fix)

Operators creating agents reach for a set of defaults; undocumented defaults → inconsistency. `packages/scopes/defaults.ts` exports named tiers and `agent.create` accepts a `template: AgentScopeTier | "custom"` input:

```ts
export const AGENT_SCOPE_TIERS = {
  "read-only": [
    "doc:read", "block:read", "comment:read", "search:read", "workspace:read"
  ],
  "author": [
    ...AGENT_SCOPE_TIERS["read-only"],
    "doc:write", "block:write", "comment:write"
  ],
  "editor": [
    ...AGENT_SCOPE_TIERS["author"],
    "doc:delete", "doc:publish", "comment:resolve"
  ],
  "admin": [
    ...AGENT_SCOPE_TIERS["editor"],
    "permission:grant", "permission:revoke",
    "agent:create", "agent:revoke"
  ],
} as const satisfies Record<string, readonly Scope[]>;
```

- `admin` tier does **not** include `"admin"` scope — that is `humanOnly` in every capability that uses it (F19 admin family). An agent with tier=admin still cannot call `workspace.purge`, `doc.purge`, `admin.diagnose`, etc. An operator who wants an agent to do operator work accepts they're on the human hook for the consequences and grants `"admin"` explicitly via tier=`custom`.
- Tier is recorded on the agent (`agents.scope_tier TEXT`); `agent.create`'s audit effect captures both the tier name and the resolved scope set so downstream audits aren't ambiguous about grant intent.
- Changing a tier definition is a breaking change for existing agents; default behavior on upgrade is **not** to broaden existing agents' scopes — tiers are computed-once at create time, stored at rest as an explicit scope set on the key's `metadata.permissions`.

### 8.5 `humanOnly` semantics

`humanOnly: true` means the capability is **auto-denied for any `kind: "agent"` principal, regardless of scopes, regardless of `acting_as` delegation**. It is a categorical refusal, not a scope check. Used for:

- Operator diagnostics (bundle exports, live metrics dumps).
- Destructive terminal operations (`workspace.purge`, `doc.purge`, `workspace.delete`).
- Credential boundary operations (creating a user PAT for oneself — agents can't mint user PATs).

MCP adapter filters out `humanOnly` capabilities from `tools/list` — agents don't even see them.
