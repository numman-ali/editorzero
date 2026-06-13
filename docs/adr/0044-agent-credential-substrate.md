# 0044 — Agent credential substrate: owned bearer tokens; agents become resolvable principals

- **Status:** Proposed (2026-06-13; cross-model Codex round folded same day — 3 MUST-FIX + 2 SHOULD-FIX applied, see Review trail)
- **Supersedes / amends:** amends ADR 0016 — keeps its principal model, scope vocabulary, delegation algebra, and revocation-cascade obligations; **supersedes its credential-source table for the agent rows** (`@better-auth/api-key` / `@better-auth/agent-auth` are not adopted for agent credentials). Closes ADR 0043's deferred increment 4 (bearer/agent WS arm) and the agents-table existence obligation recorded in ADR 0040's Step-8 amendment. Extends ADR 0025 (CLI credential store) and ADR 0026 (MCP auth) with the bearer lane.

## Context

ADR 0016 (2026-04-17) accepted the polymorphic principal model and delegated the credential lifecycle to Better Auth plugins, on the refresh research's claim that `@better-auth/agent-auth` shipped at "v1.5.6". Everything *around* the credential substrate has since landed:

- `AgentPrincipal` exists in `@editorzero/principal` (scopes, `token_id`, `token_kind`, `owner_user_id`, optional `acting_as`), with `isAgent`/`isDelegated` guards.
- The H8 `acting_as` ∩ delegator intersection is live in `workspaceAwareGate` (ADR 0040 Step 6), with the structural `delegator_not_member` deny.
- The ceiling resolver has a complete agent posture: non-delegated agents reach content via **grants only** (no org baseline, no roster rungs, admin backstop fails closed); delegated agents collapse to the delegator's read identity.
- `grants.subject_kind = 'agent'` is live; `permission.grant` mints agent edges today, with row existence validation recorded as this slice's obligation.
- The audit envelope already attributes distinctly: `principal_kind`, `principal_id: UserId | AgentId`, `acting_as_user_id`, `token_id`.
- The revocation tap (ADR 0043 Decision 5) closes sockets on revoke-class capability commits; its agent-kind derivations are currently *skipped* because no agent socket can exist.
- `created_by` attribution is settled in code (`doc.create`): user → self; delegated agent → `acting_as`; owner-scoped agent → owner; **ownerless autonomous agent → typed refusal** until `docs.created_by` widens.
- `AGENT_SCOPE_TIERS` (read-only/author/editor/admin bundles) sit in `@editorzero/scopes` (§8.4).

What does **not** exist: an `agents` table, any token substrate, any bearer arm in the resolver (cookie-only by ADR 0043's documented scope), rate-limit *enforcement* (metadata + `RateLimitError` only), and agent identity in the collab socket registry.

**Point-of-use re-verification (2026-06-13, live npm + installed dist) corrects the 0016 record:**

- `better-auth@1.6.5` (our pin) ships **no** api-key plugin in core; the plugin moved to `@better-auth/api-key`, which tracks the core line (1.6.5 exists; latest 1.6.18) and peer-pins it tightly (`@better-auth/utils` exact-pinned).
- `@better-auth/agent-auth` latest is **0.6.2** — pre-1.0, not "1.5.6". The refresh research misread it; the Agent Auth Protocol remains unstable, exactly what 0016's own consequence note feared.
- Better Auth's tables are *not* in our schema: they live outside the Kysely `Database` type, outside the three-file DDL lockstep, outside `TENANT_SCOPE_COLUMNS`/Check 11, managed by `runMigrations()` in a shared-DB posture with no cross-boundary FKs (ADR 0030's landed shape). A plugin token table would inherit that whole posture.

## Decision 1 — Owned token substrate; the api-key plugin is not adopted

Agent bearer tokens are an **owned table** (`agent_tokens`) in the three-file DDL lockstep, written and revoked exclusively through capabilities in the dispatcher tx. Better Auth keeps what it owns today — human session auth. The boundary becomes: **humans authenticate through Better Auth; agents authenticate through the editorzero substrate.**

Why the plugin loses on this codebase's own invariants:

1. **Invariant 3 (one mutation = one audit row, atomically).** The plugin writes through its own adapter in its own tx; a capability wrapping `auth.api.createApiKey` would commit the token and the audit row in two transactions with a crash window between them. An owned table commits token row + audit row in **one** dispatcher tx — the same property the whole write path is built on.
2. **The lockstep.** An owned table gets `schema.ts` typing, SQLite/Postgres DDL parity (Check 7), `TENANT_SCOPE_COLUMNS` registration with compile-time `satisfies` enforcement, and coherence Check 11 — by construction. The plugin's table gets `referenceId`-by-convention and none of the machinery.
3. **Scopes are ours.** The plugin's `permissions` field speaks its own access DSL; our vocabulary is `@editorzero/scopes`. Mapping or metadata-smuggling is a standing drift surface against an SSOT rule we already enforce everywhere else (ADR 0034).
4. **Revocation is tap-native.** `agent.token_revoke` as a capability flows through `withRevocationTap` like every other revoke-class commit — no parallel `onAuthRevoked`-style wrap around Better Auth endpoints.
5. **Capability parity (invariant 4) forbids the plugin's main surface anyway.** Token lifecycle must be capabilities (API/CLI/MCP/UI); we would mount none of the plugin's endpoints and use only its storage + verify internals — a dependency for a hash table.

What owning costs — the crypto hygiene, named so it gets built and tested deliberately:

- **Format:** `ez_agent_<43 chars base62>` (256 bits entropy via rejection-sampled `crypto.randomBytes`). The fixed prefix is the secret-scanner contract (GitHub-PAT pattern) and the resolver's cheap discriminator.
- **Storage:** `token_hash = SHA-256(secret)`, hex, with a **global UNIQUE constraint** (live + revoked rows alike — the schema encodes "one secret resolves to at most one row"; a duplicate match is structural corruption by definition, not a code path). High-entropy random tokens need a fast hash, not a KDF — brute force against 2²⁵⁶ is the bound, not dictionary attacks. The plaintext secret exists only in the `agent.token_mint` **output** (show-once); it never lands in any row, log, or audit effect.
- **Verification:** indexed lookup by the full digest. The security property is exactly that — *full-digest indexed lookup over high entropy* — not a constant-time string compare (there is no memcmp; the unique-index probe is the comparison, and a probe on the full digest exposes no partial-match oracle). HMAC-with-server-pepper would harden the DB-dump-only compromise case at the price of key management and rotation; deliberately not taken in v1 (revisit trigger below).
- **Display identity:** `token_prefix` (first 12 chars of the full token) + `last4` columns, for humane listing without the secret.

`expires_at` is supported (nullable; refused at resolution when past). Scopes live **on the token** as an explicit validated list, bounded by the **non-amplification rule** (cross-model MUST-FIX):

- The mintable universe is `AGENT_MINTABLE_SCOPES = SCOPES \ {"admin"}` — **no agent token ever carries the literal `admin` scope**, from any caller. The `humanOnly` rail already makes it dead weight on an agent (every `admin`-scoped capability is humanOnly), so allowing it only invites confusion; §8.4's "operator grants `admin` explicitly via tier=custom" allowance is **retired** (an operator who wants agent operator-work is a revisit trigger, not a custom list).
- **An agent caller mints at most what it has:** when the minting principal is an agent, requested scopes must be `⊆` the caller's *effective* scopes (today: its own token scopes verbatim; when delegated credentials land: the H8-intersected set — the rule is stated against `effectiveScopes`, not raw claims). Without this, a narrow agent holding `agent:create` self-amplifies by minting a broader token. Human owner/admin callers mint anything in the mintable universe.
- Pinned by tests: an author-tier agent with `agent:create` cannot mint editor/admin-tier scopes; no caller can put `admin` on an agent token via a custom list.

`AGENT_SCOPE_TIERS` are mint-time conveniences expanded to explicit lists — no tier indirection in rows, so a later tier edit never silently re-scopes existing tokens.

This supersedes one §8.4 architecture detail: there is no `agents.scope_tier` column. The lifecycle splits identity from credential — the agent row is *who*, the token is *may-do* — so scope intent is decided per mint (rotation re-decides it), and §8.4's audit-intent rule transfers to `agent.token_mint`: its effect records **both** the tier name (or `"custom"`) and the resolved scope list, so downstream audits stay unambiguous about grant intent. §8.4's other rules carry forward unchanged (tiers computed-once at mint, never retro-broadened; the `admin` *tier* still excludes the `admin` *scope* — `humanOnly` capabilities stay human).

## Decision 2 — The `agents` table; revocation is terminal

`agents` joins the lockstep: `id` (`AgentId`, UUIDv7), `workspace_id`, `name` (1–120 chars), `owner_user_id` (**NOT NULL** in v1), `created_by`, `created_at`, `updated_at`, `revoked_at` (nullable). Partial unique `(workspace_id, name) WHERE revoked_at IS NULL` — the established live-name pattern, covered by the fixed Check 7.

- **Every v1 agent has a human owner.** `owner_user_id NOT NULL` keeps the landed `created_by` ladder total for every real principal (owner-scoped agents attribute writes to their owner). Workspace-owned automations (`owner_user_id: null` in 0016) are deferred until `docs.created_by` widens — the typed refusal in `doc.create` documents exactly this fork.
- **Owner liveness gates authentication** (cross-model MUST-FIX): the attribution chain is only honest while the owner is a live member, so bearer resolution joins a **live `workspace_members` row for the owner** — a removed owner's agents stop resolving (401) the moment the membership soft-deletes, and the revocation tap's `workspace.member_remove` derivation grows an arm closing live sockets of agents **owned by** the removed user. Deliberately *not* an auto-revoke cascade: the agent rows stay visible and admin-revocable (`agent.revoke` is the explicit lever); they just cannot authenticate while ownerless-in-effect. Named residual, not a gate: an owner *demoted* admin→member keeps previously-minted agent tokens at their minted scopes (mint-time bounding is the rule; the admin lever is revoke + re-mint under the demoted owner's authority).
- **Revocation is terminal — no un-revoke capability, by design.** Revocation is a security action, not a trash operation; invariant 6 (soft-deletes recoverable) governs deletes, and an un-revoke of a possibly-compromised principal is a footgun. Recovery is recreation under a new id. Grants to the dead id stay as **inert rows** — subject-id-bound, and server-minted UUIDv7 ids make accidental re-match effectively impossible (the "inert until matched" rule from the Step-8 amendment, now stated as the rule).
- `agent.update` is rename-only.

## Decision 3 — The capability family (8) + the grant-validation closure

`agent.create`, `agent.get`, `agent.list`, `agent.update`, `agent.revoke`, `agent.token_mint`, `agent.token_revoke`, `agent.token_list`. All metadata-only (dispatcher-tx; `METADATA_ONLY_CAPABILITIES` grows by 8).

- **Authority:** `agent:create` gates create/update/token_mint; `agent:revoke` gates revoke/token_revoke. Per `ROLE_SCOPES`, only owner/admin hold these. Reads (`get`/`list`/`token_list`): admin-tier sees all; a non-admin member sees agents they **own**. Agents themselves can hold `agent:*` scopes (the admin tier includes them) — an agent creating an agent sets `owner_user_id` to its *own* owner (authority chains to a human; no ownerless rows by construction).
- **`agent.token_mint` returns the secret once.** The output schema carries it; the **audit effect schema structurally excludes it** (effect carries `token_id`, `agent_id`, `token_prefix`, `last4`, `scopes`, `expires_at`). This is the one capability where output ≠ effect by design, and the unit test pins that the effect never contains the secret or hash.
- **`agent.revoke` cascades by construction:** resolution joins `agents.revoked_at IS NULL`, so all the agent's tokens die with the row — no token-walking. `agent.token_revoke` kills one token.
- **Both grant-minting lanes close the recorded obligation** (cross-model MUST-FIX widened it from one): an agent-kind subject must reference a **live** agent row in the workspace in `permission.grant` **and** `doc.add_guest` — the same typed subject-validation family in both. `doc.add_guest` today documents acceptance of unprovisioned agent ids; that typo-to-inert-edge path stops being mintable. This does not disturb add_guest's recovery posture (skipping the *doc's placement standing* mid-anomaly is about the resource, not the subject). **User-subject existence on the guest path stays explicitly deferred** to the identity-resolution cluster — this slice is not a user-directory slice. Pre-existing inert edges from before this slice stay inert under the stated rule.

## Decision 4 — The resolver bearer arm (HTTP + MCP for free)

The composition root composes the resolver: `Authorization: Bearer ez_agent_…` → SHA-256 → unique-indexed `agent_tokens` lookup → join live agent **→ join live owner membership** (MUST-FIX 2) → `AgentPrincipal { scopes: token.scopes, token_id, token_kind: "api-key", owner_user_id, acting_as: undefined }`. Unknown/revoked/expired token, revoked agent, or dead owner membership → `null` → the existing 401. No header → the cookie path unchanged. **Bearer wins when both are present, and an invalid explicit bearer NEVER falls back to an ambient cookie** — presenting the prefix commits the request to the bearer lane (silent cookie fallback would mask a revoked credential behind whatever session happens to ride along).

- **The resolver stays read-only.** No `last_used_at` write-on-read — the audit trail *is* the usage log (every dispatch already lands an attributed row); a usage projection is derivable later without a resolver write path.
- **MCP needs zero MCP-specific code:** `/mcp` resolves principals through the same middleware chain (ADR 0026 Commitment 1), so agents reach MCP the moment the resolver understands bearer. ADR 0026's OAuth deferral stands.
- **CLI:** the credential store (ADR 0025) grows a token kind; `EZ_TOKEN` env overrides for ephemeral use. `ez` becomes usable *by agents* — the AXI consumer.
- **Delegated tokens stay deferred, now with the honest version fact:** `@better-auth/agent-auth` is 0.6.2/pre-1.0. The gate-side H8 intersection and the ceiling's delegated collapse stay live and tested; the delegated *credential* (and ADR 0040's two delegation obligations: consent-gated `act.sub` issuance, the delegated-row-set fuzzer arm) land when the protocol stabilizes — or as an owned delegated mint if it doesn't. v1 agents are autonomous and owner-attributed.

## Decision 5 — The WS arm closes ADR 0043 increment 4

Ordered exactly as the 0043 amendment pinned — **the registry key grows before bearer WS enables**:

1. `CollabSocketEntry` becomes a discriminated union: `{ kind: "user", user_id, session_id }` | `{ kind: "agent", agent_id, token_id }`; registry gains `closeByAgent`/`closeByToken`; the revocation tap gains the agent derivations (`agent.revoke` → close by agent; `agent.token_revoke` → close by token) and **drops the agent-kind skip** on `permission.revoke` (agent sockets can now exist, so a revoked agent grant closes the agent's feeds — same posture as user grants).
2. Only then: `resolveCollabPrincipal` drops its `kind !== "user"` defensive rail and the upgrade path accepts `Authorization`. Per-frame re-resolution (the increment-3 rail) gives token-revocation freshness on the write path; the tap close is the same belt-and-braces as D5.

Read standing for agent WS attaches needs no new code: `collabAuthorize` already dispatches through `effectiveScopes` + the ceiling resolver, whose agent posture (grants-only) is live and fuzzed.

## Decision 6 — Rate-limit enforcement (the dangling invariant-8 leg)

Invariant 8 promises *distinct rate limits*; today only metadata and the 429 error type exist. This slice lands the thin honest version as its last increment: a `withRateLimit` dispatcher wrap (the `withRevocationTap` composition pattern), in-memory token buckets, **distinct defaults by principal kind** (agents tighter than users), per-capability `rateLimit` metadata honored where declared. Two SHOULD-FIX decisions baked in:

- **Bucket key is the tuple `${principal.kind}:${principal.id}`** — kind-prefixed so the user/agent id spaces can never collide after brand erasure. `token_id` is a metric/log *label only*, never the bucket key: per-token buckets would let one agent bypass limits by minting many tokens (exactly the lane MUST-FIX 1 bounds).
- **A 429 is a structured-logged, metered refusal — not an audit row.** The refusal happens at the door, pre-dispatch; it mutates nothing (invariant 3 governs mutations), and an audit-row-per-429 under flood would aim the flood at the audit table itself — the self-DoS shape ADR 0009's audit-rate-limit note exists to prevent. Not silent: the typed `RateLimitError` 429 reaches the caller, an OTel counter meters per bucket, and the structured log carries the tuple key + capability id.

Single-process is honest — the deployment is one trunk process (ADR 0027); a multi-process deployment needs a shared store and is a named revisit trigger, not silent scope.

## Decision 7 — Effects, replay, surfaces, build order

- **Replay:** all five kinds are **state-class** — `AgentState` *and* `AgentTokenState` join `PersistentWorkspaceState`, the reducer, the semantic walks, and `STATE_KIND_FIXTURES` **before** any capability emits them (the Step-7 discipline). The token effect carries every column **except `token_hash`**, so replay reconstructs the token row minus its secret material — which is the honest reading of invariant 3: secrets are *material*, not state; the projection compare excludes the hash column by design, and an investigator still reconstructs which tokens existed, with what scopes, revoked when. (The alternative — classifying tokens audit-only — would leave a revoke-that-forgot-`revoked_at` invisible to the replay property; state-class makes the integration prop cover the whole credential lifecycle.)
- **Surfaces:** API routes + CLI (`ez agent …`) + MCP tools land with the capabilities (invariant 4); the **Agents screen** (UI cells) can trail — it is *not* identity-cluster-blocked (agents are name-addressed; no user picker required). Cells are born `UI_PENDING` and flip per the established cadence.
- **Fuzz:** the §8.1a tenant-isolation fuzzer **already drives** `api-key-agent` and `delegated-agent` principals (fabricated directly, pre-resolver) with agent-kind grant subjects. The capability increment *grounds* that arm: the world-builder mints real `agents` rows (the new `permission.grant` existence validation would otherwise refuse its agent edges), and the oracles stay unchanged — the fabricated-principal posture was already the ceiling's modeled truth.

**Build order (each increment = commit(s) with its tests):**
1. Schema slice: `agents` + `agent_tokens` lockstep ×3, `TENANT_SCOPE_COLUMNS`, brands/schemas.
2. Effects + replay: the three state kinds + two substrate kinds, reducer + walks + fixtures.
3. Capabilities + routes/CLI/MCP + the `permission.grant` existence closure + fuzz arm.
4. Resolver bearer arm + CLI bearer transport.
5. WS: registry growth + tap arms, then bearer at upgrade (D4 closes; ADR 0043's build order completes).
6. `withRateLimit` enforcement increment.
7. Agents screen (trails; flips `agent.*` ui cells).

## Consequences

- Agents stop being a modeled fiction: a real principal can authenticate on every surface (API, CLI, MCP, WS) with distinct attribution, distinct scopes, distinct rate limits, and tap-integrated revocation — invariant 8 becomes enforceable end-to-end.
- The auth boundary is now a sentence: **Better Auth authenticates humans; editorzero authenticates agents.** No plugin version-lock enters the dependency graph; the unstable Agent Auth Protocol stays outside until it earns its way in.
- We own ~200 lines of well-trodden token crypto (generation, hashing, constant-time posture, show-once) and their tests — the price of dispatcher-tx atomicity and lockstep coverage.
- ADR 0016's credential-source table is half-superseded: the human rows (session, SSO, future PAT) remain Better Auth territory; the agent rows are owned. Its delegation/revocation *semantics* carry forward unchanged.
- The grants table's agent edges become validated at mint and closeable at revoke — the last "trust me" seam in the ACL family closes.

## Revisit triggers

- **`@better-auth/agent-auth` reaches a stable 1.x** → revisit the delegated-credential increment (protocol adoption vs owned delegated mint); the consent + fuzzer obligations ride with it.
- **Human PATs are requested** → a `user`-kind bearer fork on this substrate (or the api-key plugin re-evaluated for humans only); not pre-built.
- **Multi-process deployment** → the in-memory rate-limit store needs a shared backend; the wrap seam is the insertion point.
- **Workspace-owned automations** (`owner_user_id: null`) → requires the `docs.created_by` widening fork documented in `doc.create`; un-defer together.
- **Agent-to-agent delegation chains** (0016's multi-level trigger) → unchanged, still future.
- **A DB-dump-only compromise model becomes a priority** → add an HMAC server-pepper to token hashing (key-management story required); the hash column migrates by re-mint, not in place.
- **An operator genuinely needs agent operator-work** → re-open the retired §8.4 `admin`-via-custom allowance deliberately, against the `humanOnly` rail it would collide with.

## Review trail

**Cross-model round (Codex, 2026-06-13, pre-build).** Brief: the eight-point worry list (crypto ownership, terminal revocation, scopes-on-token, owner chain, resolver posture, WS ordering, rate-limit scope, grant closure). Verdict: 3 MUST-FIX + 2 SHOULD-FIX, all applied; every other lean confirmed as a keep.

- **MUST-FIX 1 (applied → Decision 1):** scope non-amplification — `AGENT_MINTABLE_SCOPES = SCOPES \ {"admin"}` + agent callers mint `⊆` their own effective scopes (stated against `effectiveScopes`, so the rule survives delegated credentials). His concrete hole: a narrow agent holding `agent:create` minting itself an admin-tier replacement token; the gate trusts autonomous scopes verbatim (`gate.ts:139`), so the new token would be real authority.
- **MUST-FIX 2 (applied → Decisions 2+4):** owner liveness — `workspace.member_remove` only soft-deletes the membership row; without the live-owner join, a removed member's agents keep operating and attributing `created_by` to a non-member. Resolution joins live owner membership; the tap closes owned-agent sockets on member removal; deliberately no auto-revoke (admin lever stays); the demotion residual is named, not gated.
- **MUST-FIX 3 (applied → Decision 3):** the existence closure covers **both** grant-minting lanes — `doc.add_guest` documents accepting unprovisioned agent ids (`add_guest.ts:23`) and would otherwise keep the exact typo-to-inert-edge debt this slice retires. User-subject existence on the guest path stays explicitly deferred (not a user-directory slice).
- **SHOULD-FIX 1 (applied → Decision 1):** `token_hash` UNIQUE globally (live + revoked) — the schema encodes the one-secret-one-row resolver invariant.
- **SHOULD-FIX 2 (applied → Decision 6):** bucket key = `${kind}:${id}` tuple (brand-erasure collision-proof); `token_id` label-only (per-token buckets = mint-to-bypass); 429s are logged + metered refusals, not audit rows (the no-accidental-ghost point decided explicitly).
- **Keeps (his confirmations):** plain SHA-256 over 256-bit entropy (no KDF; HMAC-pepper optional, now a trigger); honest framing is *full-digest indexed lookup*, not constant-time compare (wording fixed); terminal revocation sound given audit/UI show the stable agent id (they do — the envelope carries `principal_id`, and the Agents screen inherits the raw-id exactness precedent); per-token scopes right once MUST-FIX 1 bounds minting; bearer-wins + no-cookie-fallback right; resolver read-only/no `last_used_at` right; WS ordering right; thin rate limiting **belongs in-slice** ("invariant 8 explicitly promises distinct limits; keep it honest as single-process and boring").
