# Architecture — Phase 2 synthesis

**Status:** Draft (pre-red-team)
**Date:** 2026-04-17
**Inputs (Phase-2 snapshot):** ADRs 0001–0020 — later decisions 0021–0026 land as additive Phase-3 slices, cited inline. [`docs/brief.md`](brief.md), red-team + refresh trails.
**Reader:** someone who has read [`AGENTS.md`](../AGENTS.md) and [`docs/brief.md`](brief.md) — this file does **not** re-argue decisions; rationale lives in the ADRs.

---

## 1. Purpose

Turn the 20 accepted ADRs into a system design that is:

- **Coherent** — every capability, table, surface, and test fits a single mental model.
- **Implementable** — Phase 3 can scaffold a monorepo and harness against this doc without further architectural argument.
- **Verifiable** — every hard invariant from AGENTS.md maps to a specific test in the verification stack.

Anything still open after this doc is listed in [§19 Open questions](#19-open-questions-carried).

This file mixes **target-state architecture** with **landed-status callouts**. Unless a paragraph explicitly says something is "currently landed", "open", "planned", or cites a concrete test/file as present evidence, read package inventories, surface adapters, and verification paths below as the intended architecture rather than a claim that the current tree already contains every listed package or harness. Phase-closure truth lives in `docs/continuation.md`, and the sections touched by P3.6+ call out their current status inline.

## 1.1 Design posture — engineering for coding agents

This repo is built to be **worked on by coding agents** (and disciplined humans) without regression, hallucination, or drift. The product is agent-native too — humans and AI agents are peer end-users of the platform — but that's a separate concern covered by the Principal model (§3.3, §8), `agentAllowed` capability metadata (§4), and the agent-first invariants in AGENTS.md.

The **engineering discipline** below is what keeps velocity high with a solo author + agent contributors:

> If a shape exists in two places, it's drift. Promote it to a primitive; derive the rest.
> If a layer boundary can be expressed in types, a lint rule, or a codegen check, it should be.
> If an invariant must always hold, a property test proves it — not a comment.

Operationalized throughout this doc:

- **Layered responsibilities** (§16): capability → dispatcher → service → repository → infrastructure. Each layer imports only downward. Enforced by architecture lint; an agent cannot accidentally reach through.
- **One zod schema per capability → every consumer.** HTTP route (`@hono/zod-openapi`), OpenAPI, MCP tool schema, CLI parser, UI form validation, audit `input_hash`, contract tests — all read the same object. Hand-writing a second schema is forbidden.
- **Registry as the source of truth.** Surface adapters, contract-test matrix, OpenAPI, MCP tool list, permission matrix, rate-limit config, audit shape — all derived from `packages/capabilities`. Hand-written glue that could be generated is the anti-pattern.
- **Typed primitives over stringly-typed anything.** Branded IDs (`WorkspaceId`, `DocId`, `BlockId`, `CapabilityId`, `SessionId`, `TokenId`, `AgentId`, `UserId`), string-literal unions (`Scope`, `CapabilityCategory`, `FidelityTier`, `QueueName`), discriminated unions (`Principal`, `AuditEffect`, `JobPayload`, `Block`). A misused identifier is a compile error, not a test failure.
- **Type-level guarantees over runtime guards.** `TenantScopedDb` makes an un-tenanted query a build-time error. `ctx.transact` is the only way to reach a Y.Doc — no raw Hocuspocus in handlers. A capability handler that skips audit can't compile (the context requires one).
- **Semantic naming mirrors capability IDs.** `capabilities/doc/update.ts` implements `doc.update`. `capabilities/doc/update.unit.test.ts` sits next to it. When the surface adapters and contract matrix land, cross-surface contract/integration coverage derives from that same name. An agent searching for "where do I edit doc update logic" finds one place.
- **Declarative over imperative.** Capabilities, block specs, fidelity tiers, job definitions, mirror configs, permission grants — all declarative data. The framework executes; product code declares.
- **Codegen at build, property tests at commit.** Derived artifacts (OpenAPI spec, Kysely types from Atlas DDL, CLI parsers, MCP tool registrations) are generated + committed + diff-reviewable. Invariants that must always hold (Markdown round-trip, CRDT convergence, audit replay, permission three-layer, inverse-restore) are property-tested every commit.
- **Tests sized to the guarantee they prove.** Unit for pure logic, integration against real SQLite + Postgres, property for invariants, contract for surface parity, E2E for user paths + a11y. Each layer has its own test harness; a regression fails at the smallest scope that can catch it.

The specifics of the layering, the codegen inventory, the lint rules, and the test harness layout are in **[§16 Engineering primitives for agentic workflows](#16-engineering-primitives-for-agentic-workflows)**. The architecture sections between now and there name the product-side typed primitives as they appear.

## 2. System at a glance

```
              ┌───────────────────────────────────────────────┐
              │                 Clients                       │
              │   Web UI (SPA)       CLI (bun)   MCP clients  │
              │                 HTTP API (any)                │
              └──────────────┬────────────────────────────────┘
                             │  OAuth 2.1 / API key / session
                             ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │                     Caddy sidecar (ADR 0011)                       │
  │   — TLS on-demand (allow-listed via `ask`); reverse-proxies to app │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │                    Node 22 LTS app process                         │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │ Hono trunk (top-level server) — serves SPA                   │   │
  │ │   / (SPA)   /p/[slug] (static)  /api · /auth · /mcp          │   │
  │ │   embedded Hocuspocus WS (one port)                          │   │
  │ └──────────────────────────────────────────────────────────────┘   │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │ Capability routes — OpenAPI from zod (one tuple)             │   │
  │ │   typed RPC via hc<AppType> (in-proc + HTTP)                 │   │
  │ └───────────┬────────────────────────┬─────────────────────────┘   │
  │             ▼                        ▼                             │
  │ ┌───────────────────────┐ ┌─────────────────────────┐              │
  │ │ Better Auth spine     │ │ Capability dispatcher   │              │
  │ │ (ADR 0010, 0016)      │ │ (ADR 0009, 0015)        │              │
  │ │ sso / oauth-provider  │ │  registry: Map<id,Cap>  │              │
  │ │ mcp / api-key         │ │  scope+rate+audit check │              │
  │ │ agent-auth / core     │ │  calls handler          │              │
  │ └───────────┬───────────┘ └────────────┬────────────┘              │
  │             │                          │                           │
  │             │   Principal (ADR 0016)   │                           │
  │             └───────────┬──────────────┘                           │
  │                         ▼                                          │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │  Capability handler                                          │   │
  │ │   loads live Y.Doc from Hocuspocus, or hydrates from         │   │
  │ │   doc_snapshots + doc_updates; binds BlockNoteEditor to the  │   │
  │ │   live Y.XmlFragment; one editor.transact() per mutation     │   │
  │ └───────────┬───────────────────┬──────────────────────────────┘   │
  │             ▼                   ▼                                  │
  │ ┌──────────────────────┐ ┌──────────────────────┐                  │
  │ │ Hocuspocus (ADR 0006)│ │ TenantScopedDb       │                  │
  │ │   WebSocket sync     │ │ (Kysely + ALS ctx)   │                  │
  │ │   onChange: durable  │ │ + Postgres RLS       │                  │
  │ │   write to           │ │ (ADR 0015)           │                  │
  │ │   doc_updates        │ │                      │                  │
  │ └──────────┬───────────┘ └──────────┬───────────┘                  │
  │            │                        │                              │
  │            ▼                        ▼                              │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │                DB (SQLite | Postgres)                        │   │
  │ │   tenancy, principals, docs, blocks (projected),             │   │
  │ │   doc_snapshots, doc_updates, audit_events,                  │   │
  │ │   comments, attachments, search indexes, jobs,               │   │
  │ │   custom_domains, mirror_state, sessions/keys (Better Auth)  │   │
  │ └──────────────────────────────────────────────────────────────┘   │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │ Job queue (ADR 0014): pg-boss | custom SQLite                │   │
  │ │   embed, search-index, mirror.project_doc, reaper,           │   │
  │ │   webhook, email, compaction, dcr-cleanup                    │   │
  │ └──────────────────────────────────────────────────────────────┘   │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │ OTel SDK → Prometheus /metrics + OTLP (ADR 0019)             │   │
  │ └──────────────────────────────────────────────────────────────┘   │
  └────────────────────────────────────────────────────────────────────┘
       │                        │
       ▼                        ▼
  Redis (Postgres-HA only)   Object store (attachments, optional S3 mirror)
  (Hocuspocus fan-out)
```

**One process runs one binary's worth of subsystems.** SQLite mode drops Redis and uses the in-DB queue. Postgres mode adds Redis for Hocuspocus horizontal fan-out and pg-boss for jobs.

## 3. Data model

### 3.1 Conventions

- `snake_case` columns.
- Primary keys are `TEXT` (UUIDv7 hex) so they sort by creation time and work identically on SQLite and Postgres.
- All timestamps are `INTEGER` (unix epoch ms) to avoid SQLite/Postgres timezone divergence.
- Every tenant-scoped table has `workspace_id` as the first non-PK column and a covering index starting with it.
- `deleted_at INTEGER` on soft-deletable tables (ADR 0017).
- Rows created by Better Auth plugins are owned by Better Auth; we join but do not write.

### 3.2 Tenancy

```
workspaces(
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,         -- URL slug
  name              TEXT NOT NULL,
  trash_retention_days  INTEGER NOT NULL DEFAULT 30,  -- ADR 0017, [7, 365]
  diagnostic_salt   BLOB NOT NULL,                -- per-workspace HMAC salt (F64); rotated by admin.secret_rotate
  created_by        TEXT NOT NULL,                -- user_id
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER,                      -- soft-delete (ADR 0017)
  settings          TEXT NOT NULL                 -- JSON: feature flags, defaults
)

custom_domains(
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  domain          TEXT NOT NULL UNIQUE,           -- e.g. docs.acme.com
  status          TEXT NOT NULL,                  -- pending | active | revoked
  caddy_cert_id   TEXT,                           -- Caddy cert manager opaque
  verified_at     INTEGER,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
)
```

One deployment holds many workspaces. `workspaces.slug` routes the default subdomain (`<slug>.<root-host>`); `custom_domains` routes the tenant-chosen hostname through Caddy's on-demand TLS ask-endpoint (ADR 0011).

**Cross-workspace access is v2+** (red-team F16). The brief's "cross-space reads allowed but opt-in via configuration" is deferred: in v1, every tenant-scoped row is single-workspace. The extension point is reserved — a future `workspace_trust_edges(from_workspace_id, to_workspace_id, scope_grant)` table plus a `trust.*` capability family would add cross-workspace opt-in without reshaping the permission stack. Property tests encode "no cross-workspace read succeeds" as an invariant in v1; it will narrow (not disappear) in v2. Mirrors the `AccessPath.selector` reservation in ADR 0015.

### 3.3 Principals

Per ADR 0016:

```
users(               -- owned by Better Auth; read-side join only
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  image_url       TEXT,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
)

agents(
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),   -- agents are workspace-scoped; see note below
  owner_user_id   TEXT REFERENCES users(id),                 -- NULL = workspace-owned automation
  name            TEXT NOT NULL,
  description     TEXT,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
)
```

Better Auth tables (`api_key`, `agent_auth_*`, `oauth_*`, `session`, `account`) live alongside; we join on their IDs but do not manage their schemas.

**Token → agent resolution** (red-team F6 fix — aligns with ADR 0016):

- `@better-auth/api-key`'s `referenceId` **always maps to `workspace_id`**. This makes `listKeys({ referenceId: workspace_id })` work naturally for token listing, workspace-level rate-limit scoping, and per-tenant cleanup.
- The binding to a specific agent lives in `api_key.metadata = { agent_id: "...", token_kind: "api-key" | "user-pat" }`. Auth middleware resolves: `key → metadata.agent_id → agents.id`. Missing / invalid metadata = 401.
- Agent-auth tokens (`@better-auth/agent-auth`) use the same metadata shape; the plugin distinguishes via its own table but exposes the same resolver contract.

`Principal` (ADR 0016) is a **derived in-memory view**, constructed by the auth middleware from Better Auth rows + `agents` / `users` joins. Never stored as a row — always resolved per request.

**Agents are workspace-scoped by design** (red-team F27). A human who operates agents across multiple workspaces creates one agent row per workspace. `agents.workspace_id NOT NULL` makes this explicit; a single agent ID never needs cross-workspace permission logic. Documented on `agent.create`'s capability docstring.

### 3.4 Workspace membership

```
workspace_members(
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  user_id         TEXT NOT NULL REFERENCES user(id),  -- Better Auth default modelName is singular
  role            TEXT NOT NULL,                      -- owner | admin | member | guest
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  PRIMARY KEY (workspace_id, user_id)
)
```

Role → default permissions mapping lives in code (`ROLE_SCOPES` in `packages/dispatcher/src/gate.ts`), not rows. Per-doc overrides land in `doc_acls` when the ACL layer ships (§8.1 Layer 1).

**Ownership (ADR 0024).** Membership is editorzero-owned, not Better Auth-owned. BA stores credentials (`user`, `session`, `account`, `verification` tables) and mints `workspaceId` on `user.create.before`; editorzero owns the `(workspace_id, user_id) → role` join and the ADR 0017 soft-delete cascade. The resolver reads role from `workspace_members` via the `LoadRoles` callable injected at composition time — strict-on-missing: a valid session without a membership row → null → 401.

**Signup bootstrap.** A companion `user.create.after` hook in `@editorzero/auth`'s `createAuth` seeds **both** anchor rows post-commit (BA fires `after` hooks via `queueAfterTransactionHook` after the user-insert tx commits): first the `workspaces` row for the auto-minted workspace, then the `workspace_members` row as `role: "owner"`. The `workspaces` row must land first — the auto-appended tenant-scope predicate joins `workspaces.id`, so a scoped handle reads empty until that row exists. The signing-up user owns the workspace they just minted, so `"owner"` is the structurally correct role. Both inserts use `onConflict doNothing` (on `workspaces.id` / on the `(workspace_id, user_id)` PK) for retry-safety. If the `after` hook fails, BA's `signUpEmail` throws and signup fails loud — better than a silent-401 on first request. Production never hits strict-on-missing today; the resolver's null branch exists for future partial-hook-failure, ADR 0017 cascade, and migration-gap scenarios.

**Revive-in-place on re-add.** The composite PK `(workspace_id, user_id)` forces UPDATE semantics when a soft-deleted member is re-added: clearing `deleted_at`, bumping `updated_at`, and overwriting `role` on the same row. INSERT would violate the PK; a caller that re-adds a removed member gets the same row revived, not a history of adds/removes. Historical add/remove timeline lives in the audit log (`audit_events` rows for `workspace_members.add` / `.remove`), not on the membership row itself.

**Agents are not members.** Agents (ADR 0016) are first-class peer principals with their own `agents` table keyed by `(workspace_id, id)` and their own scope vocabulary. They do NOT appear in `workspace_members` — the distinction keeps `LoadRoles(workspace_id, user_id)` a user-only lookup and prevents BA's session layer from ever carrying an agent principal. Agent-facing authz runs through `AgentPrincipal.scopes` on the same `PermissionGate`; the two principal kinds share the gate, not the source table.

**Evolution axes (revisit triggers in ADR 0024).** (a) multi-workspace + invites — today one workspace per user, auto-minted on signup; (b) organisations above workspaces; (c) teams within workspaces; (d) platform-admin role (distinct from workspace `owner`). Each lands as an additive slice when the product need surfaces; the current table shape composes forward without a breaking migration.

### 3.5 Docs and collections

```
collections(
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  parent_id       TEXT REFERENCES collections(id),  -- tree; NULL = root
  title           TEXT NOT NULL,
  slug            TEXT NOT NULL,
  order_key       TEXT NOT NULL,                    -- fractional index for reorder
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  UNIQUE (workspace_id, parent_id, slug)
)

docs(
  id              TEXT PRIMARY KEY,                 -- UUIDv7
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  collection_id   TEXT REFERENCES collections(id),
  title           TEXT NOT NULL,                    -- projected from CRDT
  slug            TEXT NOT NULL,                    -- URL segment within collection
  published_slug  TEXT,                             -- URL segment on (public) route; unique per workspace when not null
  order_key       TEXT NOT NULL,                    -- fractional index
  visibility      TEXT NOT NULL DEFAULT 'workspace',-- workspace | public | private
  published_at    INTEGER,                          -- for (public) route
  latest_snapshot_seq INTEGER,                      -- pointer for mirror/reconcilers
  visibility_version  INTEGER NOT NULL DEFAULT 0,   -- bumped on set_visibility / publish / unpublish / delete / restore (F5 cache key)
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  UNIQUE (workspace_id, collection_id, slug)
)
-- (F20) partial unique index: published URL is workspace-unique.
CREATE UNIQUE INDEX docs_published_slug_unique
  ON docs(workspace_id, published_slug)
  WHERE published_slug IS NOT NULL AND deleted_at IS NULL;
```

**v1 invariant (F51): one active `custom_domain` per workspace.** The per-workspace `published_slug` uniqueness therefore implies **per-public-host uniqueness** (each workspace serves from a single hostname). If multi-domain-per-workspace lands in a future release, the unique index narrows to `(workspace_id, custom_domain_id, published_slug)` as an additive migration — no backfill required because v1 rows map 1:1 to a single domain.

**Current-state caveat on slug uniqueness.** The spec's `UNIQUE (workspace_id, parent_id, slug)` (collections) / `UNIQUE (workspace_id, collection_id, slug)` (docs) lines above are *intent*; the v1 DDL ships the same invariant via **partial unique indexes** (`packages/db/src/drivers/{sqlite,postgres}-ddl.ts`). Plain composite uniqueness treats NULL as distinct in SQL — two root-level collections could share a slug, two collection-less docs could share a slug. The partial indexes (`… WHERE parent_id IS NULL`, `… WHERE parent_id IS NOT NULL`, same split for `docs.collection_id`, all excluding `deleted_at IS NOT NULL`) express the intended "siblings unique by slug, soft-deleted excluded" semantics correctly. This caveat resolves when Atlas + kysely-codegen take over schema management (§16.9) — the partial-index DDL becomes the authoritative source and the spec snippets follow.

**Collection-tree depth cap.** `COLLECTION_MAX_DEPTH = 8` (`@editorzero/constants`) bounds any live collection to depth 0..7, strict `>=` reject form. Notion-class soft cap, not structural. **Invariant locality**: three capabilities can make a collection live — `collection.create` (new node under a parent), `collection.move` (re-parent), `collection.restore` (revive a soft-deleted row) — and each independently enforces the same `parent_depth + 1 + subtree_height >= MAX_DEPTH` reject with identical code, refusing with `ValidationError { depth_cap_exceeded }`. Required because `collection.move`'s subtree-height walk sees only *live* descendants (per the `collection.delete`-refuses-with-live-descendants invariant): a sequence "delete deep subtree bottom-up → move parent deeper → restore subtree top-down" bypasses the cap on `move` alone (each restored node's live subtree is zero at its own restore moment); restore's local check closes the window. The rule is uniform so no single op can produce a tree another op would have rejected — future tree-reshaping capabilities (cascade-delete, bulk-move, tree-copy) inherit the same locality obligation. Per-capability rationale in the handler docstrings.

**Important:** `docs.title` is **projected** from the CRDT (the `title` block of the doc). The CRDT is the source of truth (ADR 0013, ADR 0018); this column exists only so listings/search don't have to open the Y.Doc to sort by title. Rebuilt by a job on every snapshot.

**Published URL resolution** (red-team F20 fix). The `(public)/[domain]/[slug]` route resolves `(custom_domain → workspace_id, slug → published_slug)`. `published_slug` is populated on `doc.publish` (default: copy of `slug`, collision-resolved by appending `-2`, `-3`, …) and cleared on `doc.unpublish`. Workspace-internal `slug` can collide across collections (intentional — two collections can each have "Getting started"); public URLs cannot.

**v1 implementation scope (P3.7 — `doc.publish` + `doc.unpublish` landed 2026-04-20).** `published_slug` and `published_at` are the *target* DDL above but not yet in the live schema (`packages/db/src/schema.ts` → `DocsTable` has `slug`, `visibility`, `visibility_version`, no `published_*`). Both capabilities are **visibility-only**: publish flips `visibility="public"` + bumps `visibility_version` + emits `doc.publish` audit; unpublish flips back to `"workspace"` + bumps + emits `doc.unpublish`. `published_slug` collision handling + `published_at` column population (on publish) and `published_slug = null` clearing (on unpublish) land with the public-route renderer slice; until then the `(public)/[domain]/[slug]` route itself does not exist and `doc.list` / `doc.get` return every non-deleted doc regardless of `visibility`. The publish capability's response shape + audit effect already carry a `published_at` field sourced from `ctx.now()`, so the later schema widening is an additive migration (DDL adds columns; publish's UPDATE grows to set them, unpublish's UPDATE grows to clear `published_slug`; API contract unchanged on either side).

### 3.6 Blocks (projected-read-only)

```
blocks(
  id              TEXT PRIMARY KEY,                 -- native BlockNote/Yjs block id
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),  -- denormalized for RLS
  type            TEXT NOT NULL,                    -- editorzero:core/heading, etc.
  order_key       TEXT NOT NULL,                    -- position within doc (fractional)
  parent_block_id TEXT,                             -- nested blocks (lists, tables, etc.)
  content_text    TEXT NOT NULL,                    -- extracted text for FTS (see note below)
  content_json    TEXT NOT NULL,                    -- projected block JSON
  visibility      TEXT NOT NULL DEFAULT 'default',  -- default | internal | public
  updated_at      INTEGER NOT NULL
)
CREATE INDEX blocks_by_doc_order ON blocks(doc_id, order_key);
CREATE INDEX blocks_by_workspace ON blocks(workspace_id, updated_at);
CREATE INDEX blocks_by_visibility ON blocks(workspace_id, visibility, updated_at); -- public render
```

**Never written by capability handlers.** Rebuilt from the Y.Doc on every `onChange` by a debounced projection job (250 ms). The mirror workflow, the FTS indexer, and any read that needs structured block data without parsing CRDT reads here. All writes go through CRDT (ADR 0018). `visibility` and `visibility_version` are the sole exception — they're updated synchronously by `block.set_visibility`'s handler inside the dispatcher tx (the visibility flag is metadata, not CRDT content; it does not need convergent edit semantics — last writer wins).

**FTS scoping** (red-team F17 fix). `content_text` is extracted text from `content_json` for search indexing. Visibility filtering is applied **at query time**, not at index time — the index contains all blocks with their `visibility` tag, and `search.query` joins `blocks_fts` to `blocks` and filters `WHERE visibility <> 'internal' OR principal_has_internal_access`. This keeps a single index coherent and lets internal users search internal content without leaking it to external readers. Property test: "a principal without access to internal blocks cannot recover internal content via any `search.query` call, including snippet-shaped fragments."

**Tokenizer caveat.** FTS5's `unicode61 remove_diacritics 2` handles Latin-script well; CJK/Arabic/Thai get character-level tokenization which degrades BM25 relevance. Operators in non-Latin-primary workspaces can swap the tokenizer via the `blocks_fts` rebuild job (ADR 0008 admin-configurable). Property tests cover Latin only in v1; non-Latin relevance is eval-harness-tracked (ADR 0008).

### 3.7 CRDT state (ADR 0007 §compaction)

```
doc_snapshots(
  id              TEXT PRIMARY KEY,
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  workspace_id    TEXT NOT NULL,
  seq             INTEGER NOT NULL,                 -- monotonic per doc
  state           BLOB NOT NULL,                    -- Y.encodeStateAsUpdate
  created_at      INTEGER NOT NULL,
  UNIQUE (doc_id, seq)
)

doc_updates(
  id              TEXT PRIMARY KEY,
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  workspace_id    TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  update_blob     BLOB NOT NULL,                    -- Y.encodeStateAsUpdate (delta)
  principal_kind  TEXT NOT NULL,                    -- user | agent
  principal_id    TEXT NOT NULL,
  session_id      TEXT,
  created_at      INTEGER NOT NULL,
  delete_after    INTEGER,                          -- tombstone for GC
  UNIQUE (doc_id, seq)
)
```

Durability boundary (ADR 0006): every accepted update lands in `doc_updates` inside a DB tx before ack. Crash recovery: latest snapshot + replay updates. Compaction: single-tx snapshot + tombstone old updates; reaper GCs after `max(72h, RPO window)` — see §18.1 + ADR 0007 (F75/F84 reconciled floor).

### 3.8 Doc versioning (user-facing time travel)

```
doc_versions(
  id              TEXT PRIMARY KEY,
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  workspace_id    TEXT NOT NULL,
  name            TEXT,                             -- user-provided label
  snapshot_seq    INTEGER NOT NULL,                 -- pin to doc_snapshots row
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (doc_id, snapshot_seq)
)
```

Versioning ≠ snapshots (per brief): `doc_versions` is a labeled subset of snapshots the user cares about. Time-travel reads pin to `snapshot_seq` and reconstruct via the snapshot store. Snapshot compaction respects pinned versions — the compaction job never tombstones a snapshot referenced by `doc_versions`.

**`version.restore` semantics** (red-team F15 fix). Yjs is state-converging, not history-rewinding — applying an old snapshot as a new update against a newer Y.Doc does **not** revert content. Restore is therefore implemented as a **replace-and-broadcast** operation:

1. Acquire the Hocuspocus per-doc lock (serialized; no other writer during restore).
2. Emit `version.create` capturing current state as `pre_restore_version` (so the restore is itself reversible).
3. Load the target snapshot state at `from_version.snapshot_seq` into memory.
4. Compute a single replacement update = `Y.encodeStateAsUpdate` of the target Y.Doc, applied as one transaction.
5. Persist as a new `doc_updates` row at next `seq`; emit `version.restore` audit row with `snapshot_seq_before`, `snapshot_seq_after`, `from_version_id`, `pre_restore_version_id`.
6. Broadcast to active editors via Hocuspocus — client `y-prosemirror` sees the transaction and reloads view.

Property test (`version-restore.prop.ts`): `restore(A) → edits → restore(A)` yields state identical to the first `restore(A)` result.

### 3.9 Comments

```
comments(
  id              TEXT PRIMARY KEY,
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  workspace_id    TEXT NOT NULL,
  anchor          TEXT NOT NULL,                    -- JSON: { block_id, range? }
  thread_root_id  TEXT REFERENCES comments(id),     -- NULL = root, else reply
  principal_kind  TEXT NOT NULL,
  principal_id    TEXT NOT NULL,
  body_markdown   TEXT NOT NULL,
  resolved_at     INTEGER,
  resolved_by     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
)
```

Comments live in the relational store, not the CRDT: they don't need concurrent-edit semantics within a comment body, and keeping them relational simplifies listing, resolve, and notification.

### 3.10 Attachments

```
attachments(
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  uploader_kind   TEXT NOT NULL,
  uploader_id     TEXT NOT NULL,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  storage_key     TEXT NOT NULL,                    -- opaque object-store key
  sha256          TEXT NOT NULL,                    -- content hash for dedupe + integrity
  status          TEXT NOT NULL DEFAULT 'pending_scan',
                                                    -- pending_scan | active | quarantined |
                                                    -- pending_delete | deleted  (F45)
  status_since    INTEGER NOT NULL,                 -- used for two-phase delete grace
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
)

attachment_refs(
  attachment_id   TEXT NOT NULL REFERENCES attachments(id),
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  workspace_id    TEXT NOT NULL,
  first_referenced_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, doc_id)
)

-- (F18) Pinned-version snapshot of attachments; populated by version.create
attachment_pinned_refs(
  attachment_id   TEXT NOT NULL REFERENCES attachments(id),
  version_id      TEXT NOT NULL REFERENCES doc_versions(id),
  workspace_id    TEXT NOT NULL,
  PRIMARY KEY (attachment_id, version_id)
)
```

**GC lifecycle** (red-team F18 fix). Two-phase, race-free:

1. `doc.update` removes the last `attachment_refs` entry for attachment A; reaper nightly sees no live ref + no `attachment_pinned_refs`; sets `attachments.status='pending_delete'`, `status_since=now()`.
2. After a 24h grace, reaper re-checks (new versions could pin A). If still no ref and no pinned ref, `status='deleted'`, object-store blob removed, `deleted_at=now()`.
3. `version.create` eagerly writes one `attachment_pinned_refs` row per attachment present in the snapshot; any attachment in `pending_delete` at that point is promoted back to `active`.

Property test (`attachment-lifecycle.prop.ts`): for any sequence of `{upload, reference, dereference, version.create, version.restore, restore, purge, reap}`, a pinned attachment's blob never disappears while any version references it.

### 3.10a Attachment upload lifecycle (F45 + F57 + F80)

Uploads are multi-step to avoid trusting client-side content metadata and to keep large blobs off the app process. The pending-upload tracker (§3.10b) is the orphan-cleanup primitive.

1. **Request.** `attachment.request_upload(filename, content_type, size)` INSERTs a `pending_uploads` row (§3.10b) and returns a signed PUT URL (TTL 10m) against a **temporary key** `_pending/{workspace_id}/{upload_id}`. Server does not commit a final `attachments` row yet.
2. **Direct upload.** Client uploads bytes directly to the object store via the signed URL. The app process sees no bytes.
3. **Confirm.** `attachment.confirm_upload(upload_id, sha256)` verifies:
   - the object exists under `_pending/{workspace_id}/{upload_id}`,
   - size matches the declared `size` ± 0,
   - content-type header matches declared `content_type`,
   - sha256 matches the declared sha256.
   On success the **server** performs an object-store `copy` or `move` from `_pending/…` to the final **content-addressable** key `{workspace_id}/{yyyymmdd}/{content_sha256}`, DELETEs the `pending_uploads` row, and INSERTs the `attachments` row with `status='pending_scan'`.
4. **Scan + promote.** A background job reads the first 32 bytes, validates **magic bytes** against `content_type` per §3.10a's rule table (F71), and — if `VIRUS_SCAN_URL` is configured — forwards to a ClamAV sidecar. Outcomes:
   - pass → `status='active'`.
   - magic-byte mismatch or scan fail → `status='quarantined'`; admin notified; blob remains in object store for forensic review until `attachment.delete` runs.

**Magic-byte validation (F71).** A per-content-type rule table is the source of truth. Example rules:
- `image/png` → `{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47] }`
- `image/avif` → `{ offset: 4, ascii_match: ["ftypavif", "ftypavis", "ftypheic"] }`
- `application/pdf` → `{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2D] }`
Implementation uses the `file-type` library's allowlist as the authoritative source; our rule table mirrors it and is tested against the `file-type` corpus at build time.

**Fetch.** `attachment.get(id)` → signed GET URL (TTL 5m) subject to capability dispatch (ACL check on the owning doc). Quarantined attachments return 409 unless caller is `admin`.

**Size limit.** Default 100 MB per object; operator-configurable via `EDITORZERO_MAX_ATTACHMENT_BYTES`.

**Content-type allowlist.** Operator-configurable. Default includes common image (`png`, `jpeg`, `gif`, `webp`, `avif`), plaintext (`text/plain`, `text/markdown`), and office types (`pdf`, OOXML). **SVG is rejected** unless `ALLOW_SVG_UPLOADS=true` (XSS risk via embedded script).

**Workspace quota.** `workspaces.settings.attachment_quota_bytes`; `attachment.confirm_upload` refuses with `ResourceLimitError` when confirming the upload would exceed the quota. Quota is the sum of `bytes` across `status IN ('active', 'pending_scan', 'quarantined')`.

**Status transitions:**

```
pending_scan ──pass──► active ──deref──► pending_delete ──24h──► deleted
pending_scan ──fail──► quarantined ──admin.delete──► pending_delete ──► deleted
active ──version.create──► active (pinned via attachment_pinned_refs)
pending_delete ──version.create──► active  (F18 re-promotion; preserved)
```

### 3.10b Pending uploads (F80)

`pending_uploads` tracks request_upload → confirm_upload in-flight uploads so that abandoned uploads (client never calls confirm) can be garbage-collected without leaking object-store blobs.

```
pending_uploads(
  upload_id             TEXT PRIMARY KEY,                       -- UUIDv7; issued by request_upload
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id),
  storage_key           TEXT NOT NULL,                          -- temp: "_pending/{workspace_id}/{upload_id}"
  declared_size         INTEGER NOT NULL,
  declared_content_type TEXT NOT NULL,
  declared_sha256       TEXT,                                   -- client-declared; server verifies at confirm
  expires_at            INTEGER NOT NULL,                       -- created_at + 10m
  created_at            INTEGER NOT NULL
)
CREATE INDEX pending_uploads_by_expiry ON pending_uploads(expires_at);
CREATE INDEX pending_uploads_by_workspace ON pending_uploads(workspace_id, expires_at);
```

- **`attachment.request_upload`** INSERTs a row; returns signed PUT URL against the temporary key with TTL = 10m.
- **`attachment.confirm_upload`** verifies object exists + sha256 matches + size matches + content_type matches; SERVER performs an object-store `copy` or `move` from `_pending/…` to final content-addressable key `{workspace_id}/{yyyymmdd}/{content_sha256}`; DELETEs from `pending_uploads`; INSERTs into `attachments` with `status='pending_scan'`.
- **Orphan reaper.** Reaper batch `"orphan_uploads"` (§12) scans `SELECT * FROM pending_uploads WHERE expires_at < now() - interval '1 hour'` → DELETE object-store blob at `storage_key` → DELETE `pending_uploads` row.
- **Property test** `attachment-orphan-cleanup.prop.ts` fuzzes `{request_upload, confirm_upload, abandon, reaper_tick}` sequences and asserts: abandoned uploads past their expiry are reaped within one reaper cycle; no confirmed upload's blob is ever reaped.

### 3.11 Audit events

```
audit_events(
  id              TEXT PRIMARY KEY,                 -- UUIDv7; creation-ordered
  workspace_id    TEXT NOT NULL,
  capability_id   TEXT NOT NULL,                    -- e.g. doc.update
  category        TEXT NOT NULL,                    -- mutation|read|auth|admin|system
  principal_kind  TEXT NOT NULL,
  principal_id    TEXT NOT NULL,
  acting_as_user_id TEXT,                           -- ADR 0016 delegation
  session_id      TEXT,
  token_id        TEXT,
  subject_kind    TEXT NOT NULL,                    -- doc|block|workspace|agent|…
  subject_id      TEXT,
  outcome         TEXT NOT NULL,                    -- allow|deny|error
  deny_reason     TEXT,
  input_hash      TEXT NOT NULL,                    -- sha256 of normalized input
  effect          TEXT NOT NULL,                    -- JSON: the minimal mutation
                                                    --       sufficient to reconstruct state
  duration_ms     INTEGER NOT NULL,
  trace_id        TEXT,
  created_at      INTEGER NOT NULL,
  collapsed_count INTEGER NOT NULL DEFAULT 1        -- ADR 0009: same-input collapse
)
CREATE INDEX audit_by_workspace_time ON audit_events(workspace_id, created_at);
CREATE INDEX audit_by_subject ON audit_events(subject_kind, subject_id, created_at);
```

Never soft-deleted, never hard-deleted (ADR 0017). The `effect` column is the invariant's load-bearing field: replaying `effect` in `created_at` order from the empty initial state reproduces the final workspace state. See [§9 Audit and attribution](#9-audit-and-attribution) for the replay contract.

### 3.12 Permissions

Permission rows are sparse — most access is decided by role defaults in code. Rows exist only for overrides.

```
doc_acls(
  id              TEXT PRIMARY KEY,
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  workspace_id    TEXT NOT NULL,
  subject_kind    TEXT NOT NULL,                    -- user|agent|role
  subject_id      TEXT NOT NULL,                    -- user_id|agent_id|role name
  access          TEXT NOT NULL,                    -- read|comment|edit|admin
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (doc_id, subject_kind, subject_id)
)

collection_acls(
  id              TEXT PRIMARY KEY,
  collection_id   TEXT NOT NULL REFERENCES collections(id),
  workspace_id    TEXT NOT NULL,
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  access          TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  UNIQUE (collection_id, subject_kind, subject_id)
)
```

Resolution order (see [§8 Permission model](#8-permission-model)):
`role_default` ⊕ `workspace_default` ⊕ `collection_acls` ⊕ `doc_acls` ⊕ (future) `block_acls`

### 3.13 Search indexes

**SQLite mode** (ADR 0008):

```
-- Keyword index (FTS5 virtual table)
CREATE VIRTUAL TABLE blocks_fts USING fts5(
  content_text,
  content='blocks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Vector index (sqlite-vec, brute-force)
CREATE VIRTUAL TABLE blocks_vec USING vec0(
  block_id TEXT PRIMARY KEY,
  workspace_id TEXT PARTITION KEY,                  -- partition by tenant
  embedding float[384] distance_metric=cosine       -- bge-small dim
);
```

**Postgres mode** (ADR 0008):

```
-- tsvector in-row
ALTER TABLE blocks ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content_text)) STORED;
CREATE INDEX blocks_tsv_idx ON blocks USING gin(tsv);

-- pgvector >= 0.8.2 (CVE-2026-3172 patched)
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE blocks ADD COLUMN embedding vector(384);
CREATE INDEX blocks_hnsw_idx ON blocks USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**Hybrid ranking** (both modes): `bm25Candidates ∪ vectorCandidates`, fused via Reciprocal Rank Fusion with `k=60` in app code. Same fusion implementation across both drivers so ranking is identical given identical candidate sets.

### 3.14 Jobs (ADR 0014)

**SQLite driver:**

```
jobs(
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT,                             -- nullable for system jobs
  queue           TEXT NOT NULL,
  payload         BLOB,
  status          TEXT NOT NULL,                    -- pending|running|completed|failed|cancelled
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  run_after       INTEGER NOT NULL,
  owner           TEXT,
  locked_at       INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)
CREATE INDEX jobs_claim ON jobs(queue, status, run_after);
```

**Postgres driver:** pg-boss's own tables (`pgboss.job`, `pgboss.archive`, etc.). Declared ceiling on SQLite: 100 jobs/min sustained; exceed it and admin dashboard nags to migrate.

Queues enumerated in MVP:
`embed`, `search_reindex`, `projection_blocks`, `mirror.project_doc`, `mirror.push`, `reaper`, `compaction`, `webhook`, `email`, `dcr_cleanup`, `restore_search`, `purge`.

### 3.15 Mirror state (ADR 0020)

```
mirror_configs(
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) UNIQUE,
  kind            TEXT NOT NULL,                    -- git | s3
  enabled         INTEGER NOT NULL DEFAULT 0,
  remote_url      TEXT,                             -- git or s3 endpoint
  branch          TEXT NOT NULL DEFAULT 'editorzero-mirror',
  auth_kind       TEXT,                             -- github-app | ssh | pat | s3-keys
  auth_ref        TEXT,                             -- reference to secret store
  path_template   TEXT NOT NULL DEFAULT '/{collection}/{slug}.md',
  debounce_ms     INTEGER NOT NULL DEFAULT 120000,
  batch_window_ms INTEGER NOT NULL DEFAULT 60000,
  collections_include TEXT,                         -- JSON array, NULL = all
  collections_exclude TEXT,                         -- JSON array
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
)

mirror_state(
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  last_snapshot_seq INTEGER,                         -- last seq projected to mirror
  last_export_at  INTEGER,
  last_commit_sha TEXT,
  PRIMARY KEY (workspace_id, doc_id)
)
```

Mirror is idempotent by `(workspace_id, doc_id, last_snapshot_seq)`: re-running on an up-to-date pair is a no-op.

### 3.16 Sessions / keys — delegated

These are Better Auth tables (`session`, `account`, `verification`, `api_key`, `oauth_application`, `oauth_consent`, `oauth_access_token`, `oauth_refresh_token`, agent-auth tables). Schema comes from `@better-auth/kysely-adapter`; we join read-side, we do not design them. Advisory tracking (Dependabot + Socket) watches for upstream migrations.

### 3.17 Webhooks (F46)

Workspace-scoped, HMAC-signed, SSRF-safe by construction. Delivery semantics live in §12 (webhook queue); the data model:

```
webhooks(
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  url                 TEXT NOT NULL,             -- https only; DNS-pinned at create
  events              TEXT NOT NULL,             -- JSON array of event patterns
                                                 --   e.g. ["audit.appended.doc.*","doc.published"]
  secret_ref          TEXT NOT NULL,             -- SecretRef: HMAC key; rotatable
  active              INTEGER NOT NULL DEFAULT 1,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  circuit_broken_at   INTEGER,                   -- NULL = healthy; set on 20 consecutive fails
  last_success_at     INTEGER,
  resolved_ip         TEXT NOT NULL,             -- F83: IP pinned at create time
  resolved_at         INTEGER NOT NULL,          -- F83: last DNS resolution
  resolution_policy   TEXT NOT NULL DEFAULT 'manual'
                                                 -- F83: 'manual' | 'auto_on_failure'
                                                 -- CHECK (resolution_policy IN ('manual','auto_on_failure'))
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
)
```

**DNS pinning / refresh (F83).** `resolved_ip` and `resolved_at` are populated at create time. URL update recomputes both. DNS migrations require **explicit re-pinning** via either `webhook.update` (operator changes URL; resolution refreshes as a side effect) or an operator-triggered `webhook.refresh_dns` capability. Default `resolution_policy='manual'` means a webhook whose DNS has moved silently will deliver to the old IP until the operator refreshes — loud failure (connection refused / timeout) rather than quiet misdelivery. `auto_on_failure` is an opt-in that triggers DNS re-resolution after N consecutive delivery failures before circuit-break; the new `resolved_ip` is audited via `webhook.updated` (§16.3) so operators can trace silent migrations.

**URL validation at create:**

- Scheme must be `https://`.
- DNS resolution must yield a **public unicast IP**. Blocklist (F63):
  - **IPv4:** `127.0.0.0/8` (loopback), `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC1918), `169.254.0.0/16` (link-local), `100.64.0.0/10` (CGNAT / RFC 6598), `0.0.0.0/8` (current-network), `224.0.0.0/4` (multicast), `240.0.0.0/4` (reserved).
  - **IPv6:** `::1/128` (loopback), `fc00::/7` (ULA), `fe80::/10` (link-local), `ff00::/8` (multicast), `100::/64` (discard), `::/128` (unspecified), **`::ffff:0:0/96` (IPv4-mapped IPv6 — critical)**: attackers can bypass an IPv4-only blocklist via `::ffff:10.0.0.5` or similar; this range MUST be blocked.
- **Prefer a known-good IP-range library (`ipaddr.js`)** with category-based allowlist (`unicast` only) rather than maintaining a handwritten blocklist. Handwritten lists drift; category-based allowlists don't.
- The resolved IP is **pinned** on the webhook row; delivery dials that IP directly, bypassing further DNS. This prevents DNS rebinding attacks where an initially-public name resolves to an internal IP during delivery.
- Property test covers **IPv4-mapped IPv6** specifically (the category-miss that most handwritten blocklists forget).

**Signing (delivery-side):**

- `X-EditorZero-Signature: v1=<hex(HMAC-SHA256(secret, "<timestamp>.<body>"))>`
- `X-EditorZero-Timestamp: <unix_ms>`
- Receivers reject timestamps outside a **5-minute skew window** (documented in the operator webhook spec).

**Canonical body (F62).** The signed body is the **exact UTF-8 bytes of the HTTP POST body** — not a re-serialized JSON object. Signer and receiver **MUST** compute HMAC over raw body bytes **before any JSON parsing**. Any content-negotiation or framework-level body-transform (compression, re-encoding, key-reordering) must run **after** signature verification. A mismatch between signer and receiver on byte-level canonicalization (e.g., one side re-serializes to ensure UTF-8 normalization, the other doesn't) breaks every delivery; the rule is "raw bytes, no transform, verify first." Property test `webhook-hmac-canonical.prop.ts` fuzzes JSON with non-ASCII content and nested structures and asserts end-to-end signature survives round-trip.

**Delivery retry and circuit-break:** 10s HTTP timeout; 3× exponential backoff (1s, 5s, 30s). 20 consecutive failures → `active=0`, `circuit_broken_at=now()`, `admin` audit row (`webhook.circuit_broken`), dashboard alert.

Property test (`webhook-url-validation.prop.ts`): webhook URL pointing at `http://169.254.169.254/`, `http://10.0.0.1/`, `http://localhost:9090/`, `http://[::1]/` is rejected at create time with `ValidationError`.

### 3.18 Reconcile bases (F66/F73)

`reconcile_bases` holds the server-side snapshots that back `reconcile_base_token` issuance from `doc.get` / `doc.get_markdown`. See §6.6 for the reconcile flow.

```
reconcile_bases(
  token           TEXT PRIMARY KEY,             -- opaque; UUIDv7 hex
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  blocks_json     TEXT NOT NULL,                -- block array at fetch time (baseline for merge)
  state_vector    BLOB NOT NULL,                -- Y.encodeStateVector at fetch time
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL              -- created_at + max(72h, tombstone_retention_floor)
)
CREATE INDEX reconcile_bases_by_expiry ON reconcile_bases(expires_at);
CREATE INDEX reconcile_bases_by_doc    ON reconcile_bases(workspace_id, doc_id, created_at);
```

- **TTL.** `expires_at = created_at + max(72h, tombstone_retention_floor)` — same floor as the `doc_updates` reaper (ADR 0007). A restore that can reach the journal can also reach the baseline.
- **Issuance** happens in `doc.get` / `doc.get_markdown` and is recorded as `AuditEffect.kind="doc.reconcile_base_token"` (transient; so GC activity is auditable).
- **Resolution** by `doc.update_from_markdown` returns `{ fetchedBlocks, fetchedStateVector }` or `ConflictError("stale_fetch", { max_reconcilable_age_ms })` if the token is missing / expired / scoped to a different `(workspace_id, doc_id)`.
- **GC.** The `reaper` queue's `"reconcile_bases"` batch (§12) scans `WHERE expires_at < now()` nightly and drops expired rows.

## 4. Capability registry

### 4.1 Shape

The capability registry (`packages/capabilities/src/*.ts`) is the single source of truth (ADR 0009):

```ts
// packages/capabilities/src/kernel.ts
export interface Capability<I, O> {
  readonly id: CapabilityId;                    // "doc.update"
  readonly category: CapabilityCategory;        // mutation|read|auth|admin|system
  readonly summary: string;                     // human/agent doc
  readonly input: z.ZodType<I>;                 // zod v4
  readonly output: z.ZodType<O>;
  readonly requires: readonly Scope[];          // always checked (ADR 0016)
  readonly humanOnly?: boolean;                 // if true → kind=agent auto-denied
  readonly agentAllowed?: {                     // additionally required when kind=agent
    extraScopes?: Scope[];                      //   agent must have these ON TOP of `requires`
    maxConcurrent?: number;                     //   per-agent in-flight cap
  };
  readonly rateLimit?: {
    per: "principal" | "workspace" | "global";
    bucket: string;                             // shared bucket name
    per_minute: number;
    burst?: number;
  };
  readonly audit: {
    subjectFrom: (input: I) => { kind: SubjectKind; id?: string };
    effectOnAllow: (input: I, output: O) => AuditEffect;     // typed; see §16.3
    effectOnDeny:  (input: I, reason: DenyReason) => AuditDeny;   // F32
    effectOnError: (input: I, error: HandlerError) => AuditError; // F32
    collapsePolicy: CollapsePolicy;                          // reads only; enforced at runtime
  };
  readonly surfaces: readonly ("api"|"cli"|"mcp"|"ui")[]; // which surfaces expose this
  readonly deprecated?: { since: string; sunset: string; replacement?: CapabilityId };
  readonly handler: (ctx: CapabilityContext, input: I) => Promise<O>;
}
```

#### `agentAllowed` vs `requires` — authorization matrix (F23 fix)

| Principal kind | `humanOnly: true` | `humanOnly: false`, `agentAllowed` absent | `humanOnly: false`, `agentAllowed` present |
|---|---|---|---|
| `user`  | allowed iff user has `requires` | allowed iff user has `requires` | allowed iff user has `requires` (agent-extra-scopes irrelevant) |
| `agent` | **denied** regardless of scopes | **denied** (agents need explicit `agentAllowed`) | allowed iff agent has `requires` **and** `agentAllowed.extraScopes` (plus `owner.permissions ⊇ requires` when `acting_as`) |

Rule-of-thumb for new capabilities:
- **Safe reads and benign mutations:** `humanOnly: false`, `agentAllowed: { }` (same scopes as humans).
- **Power-user reads / mutations agents may use:** add `extraScopes` on top (e.g., `agent:create` for capabilities that create other agents).
- **Destructive or operator-scope:** `humanOnly: true` — surfaces still expose to API/CLI for ops tooling, but **not** to MCP (§15.1: MCP adapter filters `humanOnly` capabilities out).

- Schemas are **zod v4 StandardSchema-compatible** so the MCP SDK (v1 stable accepts zod v4), Hono's `@hono/zod-openapi`, and our CLI commander parser all consume the same object. Swapping to Valibot or ArkType later is a codemod, not a rewrite.
- The full `CapabilityContext` — the only thing a handler can touch — is spec'd in [§16.4](#164-capabilitycontext--the-primitive-every-handler-consumes).

### 4.2 Canonical capability set (MVP)

See [Appendix A](#appendix-a--capability-matrix) for the exhaustive matrix. Groupings:

| Group | Capabilities |
|---|---|
| **workspace** | `workspace.create`, `workspace.update`, `workspace.get`, `workspace.list`, `workspace.delete`, `workspace.restore`, `workspace.purge`, `workspace.member_add`, `workspace.member_list`, `workspace.member_remove`, `workspace.member_update_role` |
| **collection** | `collection.create`, `collection.update`, `collection.move`, `collection.delete`, `collection.restore`, `collection.list` |
| **doc** | `doc.create`, `doc.get`, `doc.list`, `doc.update`, `doc.update_from_markdown`, `doc.rename`, `doc.move`, `doc.delete`, `doc.restore`, `doc.purge`, `doc.publish`, `doc.unpublish` |
| **block** | `block.update`, `block.insert`, `block.remove`, `block.set_visibility` (doc-level wrappers also accept block ops; these are the granular forms) |
| **version** | `version.create`, `version.list`, `version.get`, `version.restore` |
| **comment** | `comment.create`, `comment.update`, `comment.resolve`, `comment.delete`, `comment.list` |
| **attachment** | `attachment.request_upload`, `attachment.confirm_upload`, `attachment.get`, `attachment.delete` |
| **search** | `search.query`, `search.reindex` (admin) |
| **permission** | `permission.grant`, `permission.revoke`, `permission.list` |
| **principal** | `agent.create`, `agent.rename`, `agent.revoke`, `agent.list`, `token.create`, `token.revoke`, `token.list` |
| **mirror** | `mirror.configure`, `mirror.enable`, `mirror.disable`, `mirror.push_now`, `mirror.reset_state`, `mirror.reset_auth` |
| **webhook** | `webhook.create`, `webhook.update`, `webhook.list`, `webhook.get`, `webhook.delete`, `webhook.test_delivery`, `webhook.rotate_secret`, `webhook.refresh_dns` |
| **admin** | `admin.health`, `admin.metrics`, `admin.diagnose`, `admin.purge_runner`, `admin.secret_rotate`, `admin.job_*`, `admin.queue_*`, `admin.reindex_workspace`, `admin.reembed_workspace`, `admin.evict_doc`, `admin.unlock_doc` |
| **introspection** | `capabilities.list`, `capabilities.describe` (for agent discovery) |

`capabilities.describe` returns schemas from the registry — agents can self-discover the contract without human-readable docs. Powers the MCP tool/resource split (§5.3).

### 4.3 Lifecycle and discovery

- Registration: modules register capabilities by import; a build-time barrel assembles the `Map<id, Capability>`.
- Changes: a new capability lands with its contract test (ADR 0009). Removing or renaming a capability is a breaking change — see [§4.4 Versioning](#44-versioning).
- Discovery: `capabilities.list` is itself a capability; agents self-discover.

### 4.4 Versioning

MVP is `v1`. Breaking changes ship a new capability id alongside (`doc.update_v2`) with the old kept for a deprecation window. The registry exposes a `deprecated: { since, sunset, replacement }` field intended to be consumed by the four surface adapters once they land; OpenAPI will mark deprecated operations, MCP tool descriptions will link the replacement, and CLI/UI surfaces will surface the warning.

## 5. Four-surface adapters

Invariant #4 is the **target parity contract**, not current-tree status: as of P3.7 the shared registry/dispatcher/sync primitive + Hono trunk + CLI surface + MCP adapter have all landed (`packages/api-server`, `packages/api-client`, `packages/mcp-server`, `apps/cli`); still absent are `apps/{app,admin}` (Web UI) and `packages/contract-tests` (cross-surface parity harness). The subsections below describe the intended adapters and matrix; for surfaces that have landed, hand-written adapter glue is **forbidden** — the three existing surfaces all derive from the capability registry.

> **Read [ADR 0021](adr/0021-surface-transport-topology.md) before implementing any §5.x slice.** It names the Hono app as the single trunk, commits each eventual surface adapter (Web UI SPA / CLI / MCP) to consuming it via typed RPC (`hc<AppType>` — in-process via `app.request` for server-side callers, HTTP for clients), drops MCP stdio in favour of Streamable HTTP, names `citty` as the CLI framework, and pins `@hono/mcp` as the MCP integration. The subsections below describe the resulting surfaces; the ADR is the why.

### 5.1 HTTP API (Hono)

- Mounted under `/api/v1/*` and `/mcp` (via `@better-auth/mcp`'s `mcpAuthHono`).
- Route generator iterates the registry; per capability emits a `createRoute`/`openapi`-style handler via `@hono/zod-openapi`.
- Auth middleware: Better Auth resolves credential → `Principal`; sets `TenantContext` in `AsyncLocalStorage`.
- Dispatcher middleware: looks up capability, validates input via zod, checks `requires` against `Principal.scopes` (and workspace role), enforces `rateLimit`, calls handler, validates output, writes audit, emits OTel span.

### 5.2 CLI (Bun-compiled binary)

- **Framework: `citty`** (Unjs, near-zero deps, compile-clean under `bun build --compile`). commander / oclif / clipanion evaluated and rejected — see [ADR 0021](adr/0021-surface-transport-topology.md).
- **Transport: HTTP client of the API trunk** via `hc<AppType>(baseUrl)` from `hono/client`. The CLI never holds the dispatcher directly; it is a first-class HTTP consumer of `/api/v1/*` identical to any other external client.
- One subcommand per capability generated from the registry: `editorzero doc create --workspace ws1 --title "..."`.
- Argument parser built from the capability's zod input (registry source) via a citty `defineCommand` loop.
- **Auth ([ADR 0025](adr/0025-cli-auth-bootstrap-credential-store.md))**: first-slice bootstrap is email+password → session cookie stored in `~/.editorzero/credentials` (mode 0600), resent on every `hc<AppType>` call. `AuthCredentialStore` seam in `apps/cli/src/auth/` keeps future device-flow / PAT / agent-auth stores as drop-in implementations — command tree doesn't change on credential-model swap. Dual-mode input: interactive prompt in TTY, `--password-stdin` in non-TTY (AXI "no interactive prompts" in agent mode; standard `podman login --password-stdin` idiom). 401s fail loud with AXI-shaped envelope `code: "auth_expired"` + re-login hint. Device flow and PAT paste deferred to standalone ADRs gated on Web UI / admin-surface slices.
- **`ez auth whoami`** calls `/infra/whoami`, a trunk route that wraps `c.get("principal")` and returns editorzero's `Principal` shape (`kind`, `id`, `workspace_id`, `roles`, `session_id` / `token_id`). **Not** BA's `/auth/get-session` — that returns BA session/user state, which diverges from what the dispatcher/gate enforces. Same middleware chain as capability routes → single source of principal truth.
- **Output governed by [AXI](https://github.com/kunchenguid/axi) in agent mode; [clig.dev](https://clig.dev/) in TTY mode.** See ADR 0021 for the full commitments. Summary:
  - Agent mode (non-TTY or `--agent`): minimal default schemas, pre-computed aggregates, structured errors **on stdout** with typed `code`, idempotent mutations exit 0 on no-op, no prompts, content-first home view.
  - TTY mode: table / YAML, colour (respecting `NO_COLOR`), clig.dev error conventions, human prose.
  - **Stdout format for agent mode is pending eval** — TOON, JSON, JSONL, YAML-compact evaluated on token cost AND agent task-completion success. JSON is the interim default until the eval runs (ADR 0021 Decision §6).
- **Session-hook self-install** for Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`) on first invocation. `SessionStart` hook emits a compact workspace dashboard as ambient context, in whichever agent-mode serializer the preceding bullet currently selects (JSON until the ADR 0021 serializer eval runs). Absolute-path hook command, self-heals on relocation.
- Distribution: `bun build --compile --bytecode` per target tuple (linux-amd64, linux-arm64, darwin-amd64, darwin-arm64, windows-amd64). Binary ~60MB.

### 5.3 MCP (`@modelcontextprotocol/sdk` 1.x stable)

Per ADR 0009 + [ADR 0021](adr/0021-surface-transport-topology.md), capabilities map to MCP concepts:

- **Integration**: `@hono/mcp`'s `StreamableHTTPTransport` mounted at `app.all('/mcp', ...)` inside the same Hono app that serves `/api/v1/*`. `xmcp` and `FastMCP TS` evaluated and rejected in ADR 0021 (xmcp has no Hono adapter and its file-system routing fights the capability registry; FastMCP wraps Hono backwards and duplicates Better Auth).
- **Tools**: every `mutation` + `read` capability becomes a tool, registered programmatically via `server.tool()` in a registry loop. Input schema = capability.input. Output schema surfaced via the SDK's `outputSchema`.
- **Resources**: pinnable context — `editorzero://workspace/{id}/doc/{id}` (rendered Markdown per ADR 0013 fidelity), `editorzero://workspace/{id}/doc-tree`, `editorzero://workspace/{id}/schema`. Each resource is a thin wrapper around a read capability.
- **Prompts**: authoring templates; populated from a registry extension (not part of MVP capability set).
- **Toolsets**: grouped via `X-MCP-Tools` header; `--read-only` mode filters to category=`read`.
- **Transport**: **Streamable HTTP only**. Stdio transport is **dropped** (ADR 0021) — local-subprocess MCP agents point at `http://<host>/mcp` (same auth story as remote). HTTP+SSE remains a deprecated fallback per MCP spec.
- **Auth**: `withMcpAuth` / `mcpAuthHono` (`@better-auth/mcp`) in front of the transport on the same Hono route. OAuth 2.1 DCR + PKCE S256 + RFC 8707 audience; `resolveTenantAudience(host)` binds custom-domain tenants.
- **Reconnect**: keepalive 15 s, `Mcp-Session-Id` + `Last-Event-Id` resume, `tool_call_id` persisted 24 h for interrupted calls.

### 5.4 Web UI (Hono trunk + Vite/React SPA — ADR 0027–0033)

> **Topology re-decided 2026-05-30 ([ADR 0027](adr/0027-web-ui-topology.md)–0033), superseding the Next.js design ([ADR 0005](adr/0005-ui-framework.md)).** The Hono trunk is the top-level server; there is no framework above it. The Next-specific machinery this section used to describe (Server Actions/RSC, header-forwarding across a synthesized request, `"use cache"`) is retired.

- **In-process typed RPC is preserved** ([ADR 0021](adr/0021-surface-transport-topology.md), [ADR 0027](adr/0027-web-ui-topology.md)). `@editorzero/api-client` still exports `createServerClient()` = `hc<AppType>` bound to `app.request.bind(app)` — full middleware chain (Better Auth → `Principal` → tenant scope → rate limit → dispatcher), zero TCP. It now serves SSR-shell / reader-render callers rather than Next Server Actions/RSC; the SPA uses `createHttpClient()` over same-origin fetch. Server-side callers never invoke the dispatcher outside this chain (invariant 5).
- **Same-origin auth** ([ADR 0030](adr/0030-better-auth-mount.md)). Better Auth mounts directly on the trunk; SPA, RPC, and `/auth/*` share one origin → first-party `SameSite=Lax` cookies, no CORS, no synthesized-request header-forwarding allowlist (so no spoofed-tenant-hint risk), and the Better-Auth-in-`"use cache"` gotcha is moot.
- **Editor route is client-only** (`ssr: false`; [ADR 0031](adr/0031-editor-substrate.md)). Bootstraps on BlockNote + `y-prosemirror` over the embedded Hocuspocus WebSocket; ejects to Tiptap v3 + an owned thin block layer (clean-start) fused with the version-history/track-changes slice ([ADR 0032](adr/0032-version-history-track-changes.md)). Production collab is gated on **broadcast-after-commit** so a rolled-back SQL tx never leaves a mutation resident in the live `Y.Doc` (ADR 0027 / invariant 7).
- **Published docs are event-rendered static HTML** ([ADR 0027](adr/0027-web-ui-topology.md)), replacing the `"use cache"` + `cacheLife` + `revalidateTag` design. An outbox consumer regenerates a published doc's HTML on **both** `doc.visibility_changed` (publish/unpublish/delete/restore) **and** `doc.updated` (content edits to an already-published doc) — keying on visibility alone was a staleness bug. Rendered via a neutral block-JSON→HTML projection (not BlockNote's `blocksToFullHTML`), written under `./data/published/<workspace>/<slug>.html(.br)`, served with `ETag` / `must-revalidate` (the shareable slug can't carry a content hash, so not `immutable`; only hashed sub-assets are `immutable`).
  - Cache/artifact key: composite (`workspace_id`, `doc_id`, `visibility_version`, content-hash). `visibility_version` remains a scalar per-doc counter bumped on `block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.delete`, `doc.restore`; the content-hash arm catches content edits to an already-published doc, which `visibility_version` does not move. Delete/restore must flip the public render 200↔404 (F5 + ADR 0017).
  - The outbox consumer (not a Server Action) re-renders on the events above and writes/evicts the static artifact; publish-snapshot-vs-live-latest semantics are a reader-slice product decision (ADR 0027).
  - Property test (`public-cache-invariance.prop.ts`, adapted to the artifact): after any sequence of `{block.set_visibility, doc.publish, doc.unpublish, doc.delete, doc.restore, block.update}`, the rendered public HTML contains no `visibility='internal'` block content as of that snapshot, and a soft-deleted doc renders 404 regardless of prior publish state — now asserted against the event-rendered artifact rather than a `"use cache"` key.
- `proxy.ts` resolves `Host` → workspace via `custom_domains` using a small in-memory LRU primed at startup and invalidated on `custom_domains` mutation. **In HA mode (F53):** `custom_domain.add`, `custom_domain.remove`, `custom_domain.verify` publish `custom_domains:invalidated` on the Redis pub/sub channel; each node's proxy LRU subscribes and evicts matching keys. LRU entries also carry a **60s TTL** as a safety net so that a missed pub/sub message self-heals within one minute.

### 5.5 Contract enforcement

Planned contract-test matrix (target shape once the surface adapters + `packages/contract-tests` land; not present in the tree today):

1. **Existence matrix** — for every `(capability, surface)` pair where the capability is type-compatible, a generated surface must exist and reach the same handler.
2. **Shared-fixture matrix** — the same capability invoked on each surface with the same input produces the same output + the same audit row (modulo surface-specific metadata).
3. **Error-parity** — permission denial and validation errors produce the same error code + shape across surfaces.

The matrix is generated from the registry, so once it lands "a new capability didn't add its MCP tool" fails contract tests without a hand-maintained checklist.

#### 5.5.2 Matrix dimensions and suppression (F42)

Without bounds, the matrix is `capability × surface × principal_profile × outcome` — combinatorial explosion. Formalized so every cell is either exercised or suppressed with a cited reason:

- **Matrix cell:** `{ capability, surface, principal_profile, outcome }` where `principal_profile ∈ { anonymous, member, admin, agent-basic, agent-delegated, agent-power }` and `outcome ∈ { allow, deny, validate_error }`.
- **Suppression rules (cell is skipped, not a test gap):**
  - **(a) `humanOnly` × agent principals** — skip. Capabilities marked `humanOnly: true` have a categorical deny for agents already enforced by dispatcher; no cell adds signal.
  - **(b) Capability not on surface** — skip. E.g. `doc.update_from_markdown` has `surfaces: ["api", "cli", "mcp"]`; UI cells are skipped.
  - **(c) Authorization-impossible outcome** — skip. `anonymous` × an admin capability has `allow` as impossible; only the `deny` cell runs.
  - **(d) Capability post-sunset (F72)** — `current date > capability.deprecated.sunset` → cell suppressed; matrix-snapshot diff flags removal for reviewer. Pre-sunset deprecated capabilities continue to exercise all cells.
- **Surface-specific metadata excluded from cross-surface equality:** the fixed list `["x-session-id", "x-request-id", "x-trace-id", "x-ratelimit-*"]`. Everything else must match byte-for-byte across surfaces.
- **Matrix snapshot.** The resolved matrix will be emitted as `contract-matrix.snapshot.json`, committed, and diff-reviewed. Adding a capability will update the snapshot in the same commit so reviewers see the delta.
- **Meta-test.** Planned `packages/contract-tests/test/meta.test.ts` will assert: **every possible cell either runs or matches a suppression rule with a cited reason.** "Just didn't add this one" is a meta-test failure, not a silent gap.

## 6. Unified write path (ADR 0018)

> **Read [ADR 0022](adr/0022-agent-editing-constraints.md) before implementing `doc.update`.** It adds an OPTIONAL per-op `expect_prior_content_hash` field (SHA-256 of canonicalized prior block JSON) on `update`/`move`/`remove`/`set_visibility` ops, plus a reserved `precondition_policy?: "strict"` discriminator. The precondition check lives inside the handler's `ctx.transact` closure and throws `StalePreconditionError` on mismatch before any op applies. The field is optional so the human UI (BlockNote via Hocuspocus) omits it; agents always send it. Reserves `AccessPath.markdown_anchor` (null-only in v1). Defers the full agent-ergonomic wrapper ADR (`doc.read` / `doc.grep` / `block.edit` etc.) to post-traffic evidence.

### 6.1 Pipeline

Every **content mutation** (any `category = "mutation"` capability that is *not* in `METADATA_ONLY_CAPABILITIES` — see §6.5 / `packages/scopes`), once a surface adapter invokes it, flows through this pipeline. Metadata-only mutations (`block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.delete`, `doc.restore`, `doc.move`, `collection.*`) take the dispatcher-tx-only path described in §6.5 / ADR 0018 — they never call `ctx.transact`, never open a Hocuspocus direct connection, never write `doc_updates`. Their **landed tuple** at the trunk composition root (`packages/api-server/src/composition/createApiDispatcher.ts`) is: the capability's relational metadata write(s) + capability-specific handler-emitted `ctx.outbox(...)` rows (e.g. `doc.publish` / `doc.unpublish` emit `doc.visibility_changed`) + `audit_events(allow)` + `outbox(audit.appended)`. The handler-emitted outbox rows are queued during `fn(extras, auditTx)` and flushed via `createOutboxWriter().append(auditTx, …)` before the `withSystemTx` region commits, so the whole tuple is single-tx atomic. The dispatcher-package's own test fixtures under `packages/dispatcher/{src,prop}/` still pass `ctx.outbox(...)` as a no-op stub — those tests verify dispatcher semantics in isolation, not trunk composition; the trunk contract is pinned by `packages/api-server/src/composition/createApiDispatcher.integration.test.ts` and will be further hardened by the N-way fault-injection property test planned in §17.1 row 7b. Red-team F3 + F9 + F10 + F31 tightened ownership, atomicity, and crash-recovery guarantees for the content-mutation pipeline below. **Single-tx semantics (F31):** `doc_updates`, `audit_events`, and both dispatcher-emitted `outbox` rows commit in one DB transaction; there is no window in which a CRDT update exists without its audit row or vice versa.

```
Request → surface adapter → dispatcher:
  1. resolve Principal, TenantContext; open OTel span
  2. permission + scope + rate-limit checks (emit deny audit + return if fail)
  3. call capability handler(ctx, input)
       handler calls ctx.transact(doc_id, fn) exactly once:
         a. open Hocuspocus direct connection; per-doc serializer acquires the doc
            (hydrate from doc_snapshots + doc_updates if not resident)
         b. direct.transact(ydoc => ...) binds
              BlockNoteEditor.create({ collaboration: { fragment } })
              and runs fn(editor) inside editor.transact(...) → one Yjs update u
         c. Yjs resource limits on u (ADR 0003); reject-on-breach
         d. capture post-state from the editor (readable inside the transact closure);
            dispatcher computes effect via
              capability.audit.effectOnAllow(input, postState) → AuditEffect
         e. TODAY: during the `direct.transact` callback, as the Yjs
            update `u` emits, Hocuspocus broadcasts it to other
            subscribers immediately (before SQL commit). On rollback,
            durable SQL state rolls
            back; `BoundSyncService.rollback()` evicts the resident
            Y.Doc only when no other connection holds the doc resident.
            With a live WS peer, the rolled-back delta stays resident
            and on that peer's local replica until reload (Phase 4 gap).
         f. Hocuspocus's per-doc DB-tx hook (onChange-equivalent) runs the single
            write transaction assembled by the dispatcher:
              BEGIN DB tx:
                compute next doc_updates.seq = prev + 1 (atomic per doc; §6.4)
                INSERT doc_updates(seq, blob, principal, session, …)
                INSERT outbox(event="doc.updated", doc_id, seq, …)
                INSERT audit_events(
                  capability_id, principal, subject, outcome="allow",
                  effect, input_hash, duration_ms, trace_id, collapsed_count=1
                )
                INSERT outbox(event="audit.appended", audit_id, …)
              COMMIT
         g. ack to waiter
         h. PLANNED (Phase 4): move the broadcast here — after COMMIT —
            via broadcast-on-commit / rollback-safe client buffering
       handler returns output O
  4. close OTel span; return O to surface adapter
```

Deny and error outcomes are written in a separate audit-only DB tx (no `doc_updates` row exists). Their effects use the `AuditDeny` / `AuditError` variants (F32 — §4.1, §16.3).

### 6.2 Ownership — who writes what

- **Dispatcher owns the write-path DB tx.** It assembles the full mutation — `doc_updates` + `outbox(doc.updated)` + `audit_events` + `outbox(audit.appended)` — and commits them together (F31). Effect is computed from `capability.audit.effectOnAllow(input, postState)` where `postState` is read inside the `direct.transact` closure before the DB tx commits.
- **Hocuspocus** supplies the per-doc serializer and the `onChange`-equivalent DB-tx hook that the dispatcher's write-path tx runs inside. It does **not** independently write `doc_updates` or `audit_events`; it provides the concurrency boundary. **TODAY** it also broadcasts the Yjs update during the `direct.transact` callback, before the dispatcher tx commits. On rollback, `BoundSyncService.rollback()` only repairs in-memory state when no other connection holds the doc resident; with a live WebSocket peer, the rolled-back delta remains resident and on the peer's local replica until reload (the `HocuspocusSync` class docstring in `packages/sync/src/hocuspocus.ts` and the `"rollback leaves the doc resident when a concurrent connection holds it"` regression test in `packages/sync/src/hocuspocus.integration.test.ts` document this). **PLANNED (Phase 4):** move broadcast to post-commit via buffered/broadcast-on-commit delivery.
- **`onStoreDocument`** (debounced, non-concurrent per doc, ADR 0006) writes `doc_snapshots`. Compaction is its job and audit is not its concern.
- **Outbox** (§6.3) is the only bridge between the write-path tx and downstream jobs; both `doc.updated` and `audit.appended` rows are inserted inside the same tx as the mutation they describe.
- **Deny / error audit writes** are owned by the dispatcher in their own audit-only DB tx, after permission-check failure or handler exception. They use `effectOnDeny` / `effectOnError` (F32).

### 6.3 Transactional outbox (F10 fix)

Background jobs (`projection_blocks`, `embed`, `mirror.project_doc`, `webhook`, `notification`) must not be enqueued outside the DB tx — a crash between commit and enqueue loses them silently. We use the **transactional outbox pattern** in both drivers:

```
outbox(
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT,
  event           TEXT NOT NULL,          -- "doc.updated" | "audit.appended" | …
  payload         TEXT NOT NULL,          -- canonical JSON
  created_at      INTEGER NOT NULL,
  forwarded_at    INTEGER,                -- NULL = pending
  forwarded_to    TEXT                    -- job id or webhook delivery id
)
```

A per-process **outbox poller** reads unforwarded rows every 250 ms (tunable), forwards each to `JobService.enqueue` with idempotency keyed on `outbox.id`, and sets `forwarded_at`. Jobs are therefore at-least-once; handlers are idempotent. On SQLite this is a small poll loop; on Postgres, pg-boss's native tx-bound `send` is an alternative but the outbox pattern keeps driver semantics identical.

**HA poller (F40 + F74).** In HA / Postgres mode the poller must be a **singleton per DB**, not per node, to avoid duplicate forwarding storms. Two-layer guarantee:

- **Primary (leader lease).** Redis lease `outbox:poller:leader` with 10s TTL; the current leader node renews on tick, re-elect on expiry. Only the leader calls `JobService.enqueue`.
- **Belt-and-suspenders (atomic claim + enqueue in one DB tx — F74).** Claim and enqueue commit **together** so a crash between steps cannot lose the enqueue. The invariant: the `forwarded_at` claim is only durable if the downstream `pgboss.job` INSERT succeeds.
  ```sql
  BEGIN;
    UPDATE outbox
       SET forwarded_at = now(), forwarded_to = $job_id
     WHERE id = $outbox_id AND forwarded_at IS NULL
    RETURNING *;
    -- No rows returned → another poller claimed it; ROLLBACK and move on.
    INSERT INTO pgboss.job (id, data, singletonKey, …)
      VALUES ($job_id, $payload, $outbox_id, …)
      ON CONFLICT (singletonKey) DO NOTHING;
  COMMIT;
  ```
  If the `INSERT INTO pgboss.job` fails for any reason (unique-violation on `singletonKey`, pg-boss table unavailable, crash mid-statement) → `ROLLBACK` undoes the `forwarded_at` claim, leaving the row for the next poll. **"Mark forwarded then enqueue" is a forbidden ordering.** For SQLite mode there's no HA concern (single writer) but the same single-tx discipline applies for crash-safety: the `forwarded_at` UPDATE and the `jobs` INSERT commit in one `BEGIN IMMEDIATE` tx.

Property test (`outbox-ha.prop.ts`): N concurrent pollers on M outbox rows forward each row exactly once. ADR 0014 is updated to note the `singletonKey = outbox.id` requirement and the single-tx contract (F74).

### 6.4 Sequence generation — atomicity (F9 + F36 + F75 fix)

`doc_updates.seq` is generated **inside** the Hocuspocus per-doc serializer (which is already non-concurrent per ADR 0006 for `onStoreDocument`; `onChange` uses the same per-doc lock for the seq assignment). Seq allocation uses a dedicated `doc_counters` table and a **row-lock** — not `SELECT max(seq) FROM doc_updates FOR UPDATE`, which is invalid SQL on an aggregate result in Postgres. The row-lock scheme works identically on both drivers.

**`doc_counters` schema:**

```sql
CREATE TABLE doc_counters (
  doc_id      UUID PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  next_seq    BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- INSERT a row on doc creation (in the same tx as docs(…)).
```

**Seq allocation — inside the write-path tx, after the per-doc serializer acquires the doc:**

```sql
-- Postgres:
SELECT next_seq FROM doc_counters WHERE doc_id = $1 FOR UPDATE;
UPDATE doc_counters SET next_seq = next_seq + 1, updated_at = now() WHERE doc_id = $1;
INSERT INTO doc_updates (doc_id, seq, …) VALUES ($1, $selected_seq, …);

-- SQLite: same query without FOR UPDATE; BEGIN IMMEDIATE serializes writers.
SELECT next_seq FROM doc_counters WHERE doc_id = ?;
UPDATE doc_counters SET next_seq = next_seq + 1, updated_at = now() WHERE doc_id = ?;
INSERT INTO doc_updates (doc_id, seq, …) VALUES (?, ?, …);
```

**Gapless seq** is preserved: `doc_counters.next_seq` increments in the same tx as the `doc_updates` INSERT. On rollback both revert, leaving `next_seq` unchanged — no gap. `UNIQUE (doc_id, seq)` is the backstop.

**Lock ordering inside the write-path tx (document explicitly to avoid deadlock):** `doc_counters` row → `doc_updates` → `audit_events` → `outbox`. All writers acquire in the same order; no cross-order paths exist.

Under HA manager rebalance, consistent-hash assignment guarantees sticky affinity; during the brief handoff window, the **old manager holds a Redis lease with TTL T (default 5s)**, and the **new manager refuses writes for 2T after lease expiry** to drain in-flight Yjs updates. MCP/API callers see `ConflictError` during that narrow rebalance window; Hocuspocus browser sessions see a "reconnecting" state and resume on the new manager. Observability: `manager.failover_count` counter + `manager.drain_window_hits` counter (ADR 0019).

**SQLite:** single-node by construction — no manager-failover race exists. `BEGIN IMMEDIATE` + WAL-mode default `SERIALIZABLE` isolation; `busy_timeout=5000` from ADR 0007 handles contention.

**Both drivers:** on `UNIQUE (doc_id, seq)` conflict the entire `ctx.transact` closure retries (up to 3 times, then `ConflictError` surfaces to the caller).

Compaction tx is disjoint from the update tx: it reads `doc_snapshots` + `doc_updates` through the current `seq`, writes a new snapshot + tombstones old updates inside its own tx. Updates arriving during compaction take a seq > compaction's checkpoint; compaction never tombstones them.

Crash during an update-write: the tx either commits or does not. Partial writes cannot persist. Crash during compaction: snapshot never appears; old data untouched; retry on next trigger.

**F68 retry-cascade bound.** The Hocuspocus per-doc serializer queues writers serially for the full `ctx.transact` closure, not just seq assignment. Retries on `UNIQUE(doc_id, seq)` conflict are therefore rare (only across dispatcher rebalance). Retry cap stays at 3; if exceeded, `ConflictError` surfaces to caller with `retry_after_ms`. Phase 3 load test verifies observed retry count < 5 at 100 concurrent writers on one doc.

**F69 compaction vs onChange serialization.** `onStoreDocument` (compaction) and `onChange` (write-path) serialize via the Hocuspocus per-doc lock; compaction cannot run concurrently with a write. Failed-insert retries produce no gaps: `doc_counters.next_seq` is incremented in the same tx as the `doc_updates` INSERT (F75); on rollback both revert, leaving `next_seq` unchanged. No gap. Property test `doc-updates-gapless.prop.ts` (§17.1) fuzzes crash sequences to assert `∀ doc: max(seq) = count(seq) AND seq values are contiguous [1..max]`.

### 6.5 Key properties

- **One `editor.transact` = one Yjs update = one `doc_updates` row = one `audit_events` row.** Atomicity for free. (F2 + F3 fix: exactly-one now means one audit row per mutation; collapse applies only to reads.)
- **No raw writes to `blocks`, `docs.content`, or any CRDT-mirror field.** Projection jobs rebuild those from the `doc.updated` outbox event.
- **Markdown-in is parsed to block ops then applied via the same transact.** See [§6.6](#66-markdown-from-agent-authoring-reconcile).
- **`ServerBlockNoteEditor.blocksToYDoc` is forbidden** — it loses history (AGENTS.md gotcha).
- **Capability handlers must call `ctx.transact` at most once.** Enforced by a runtime assertion in the dispatcher today; the planned `@editorzero/arch-lint` package will add a static `transact-called-at-most-once` rule (F89 — arch-lint is not yet implemented). Multiple mutations on the same doc batch into one transact; mutations across docs each get their own handler invocation.
- **Native moves emit `move` ops, not `remove+insert` (F33).** BlockNote drag-handle reordering and programmatic `replaceBlocks` calls that preserve block IDs produce `{ op: "move", block_id, new_parent_block_id, new_order_key }` entries in the `doc.update_batch` effect (§16.3). Downstream reducers reapply ordering without mistakenly treating a move as a delete+create, which otherwise corrupts comment anchors, attachment refs, and CRDT history attribution.

**Content mutations flow through CRDT; metadata mutations are dispatcher-tx-only (F41 + F54).** A small enumerated set of capabilities mutates only relational metadata — no Y.Doc content changes, no CRDT convergence needed:

```
metadata-only set = {
  block.set_visibility,
  doc.publish, doc.unpublish,
  doc.delete, doc.restore,
  doc.move,
  collection.create, collection.update, collection.move,
  collection.delete, collection.restore,
  workspace.update,
  workspace.member_add, workspace.member_remove, workspace.member_update_role
}
```

**`doc.rename` is NOT metadata-only (F54).** The doc title lives in the title block of the Y.Doc; `doc.rename` opens `ctx.transact(doc_id, editor => editor.updateBlock(titleBlockId, { content: newTitle }))` like any other content mutation. `docs.title` is a projected column (§3.5) rebuilt from the title block; `doc.rename`'s audit effect continues to be `doc.rename` (§16.3) but the write path is standard CRDT.

**Current-state caveat (2026-04-21, content-mutation slices `6077a8f` + `05bd2e0`).** The row-metadata projection that rebuilds `docs.title` / `docs.slug` / `docs.updated_at` from `doc.updated` does not yet exist. Until it lands, content-mutation capabilities run a **write-through row-metadata bridge** inside the dispatcher's single write-path tx — the handler UPDATEs the row-side columns it owns *first* (404 short-circuit if the row is missing or soft-deleted), then opens `ctx.transact` for the CRDT mutation. Both writes land atomically (same SQL tx; throw rolls back the row write, and `BoundSyncService.rollback` evicts the in-memory Y.Doc so the next read rehydrates from committed `doc_updates`).

- `doc.rename` (`6077a8f`) UPDATEs `title` + `slug` + `updated_at` then rewrites the title block via `setDocTitle(ydoc, title)` from `@editorzero/sync`. The title-slot rule lives in `setDocTitle`: block 0 heading-1 → `editor.updateBlock` in place (keeps block identity stable); otherwise `editor.insertBlocks` a fresh heading-1 at index 0 with `placement: "before"`.
- `doc.update` (`05bd2e0`) UPDATEs `updated_at` then applies the `insert`/`update`/`remove` op batch inside one `editor.transact` via `withLiveEditor`. Row-side freshness parity for `doc.list` / `doc.get` is the only bridge need — title + slug are content-owned (Codex review of the slice confirmed the thinner bridge is honest for update).

Once the projection lands, the row-side UPDATEs disappear and the handlers shrink to just the `ctx.transact` call; the surface contracts (input / output / audit effect) do not change.

**v1 slug semantics — slug tracks title.** The slugify step inside the handler mirrors `doc.create`'s: `docs.slug` is re-derived from the new title on every rename (kebab-case; empty base → `"untitled"`). Pragmatic for v1 because `doc.list` / `doc.get` are the only readers today — listing coherence + `docs.slug` NOT NULL are the only concerns in play, and slug-tracks-title satisfies both. Callers that expect stable public-route URLs independent of title get a future `doc.set_slug` capability that decouples the two; until that lands, rename and slug change together.

These capabilities in the metadata-only set take the dispatcher-owned DB tx without opening a Hocuspocus direct connection. The `transact-called-at-most-once` lint (§16.8) allows zero calls for capabilities in the metadata-only set; the `no-raw-ydoc-access` lint's whitelist applies to the Hocuspocus integration layer (`packages/sync/**`) and not these handlers (they never touch Y.Doc). Invariant 7 in AGENTS.md is read as "all *content* mutations flow through the CRDT"; metadata mutations are outside its scope, and §6.2 explicitly lists them as dispatcher-owned.

### 6.6 Markdown-from-agent authoring (reconcile — F8 + F37 + F44 + F66/F73 fix)

**Why `reconcile_base_token`, not `state_vector_at_fetch`.** An earlier iteration required callers to send the Yjs state vector captured when they fetched the Markdown. That shape fails in practice: a minimal HTTP agent that ran `curl /api/doc.get_markdown | jq .markdown | edit | curl -X POST /api/doc.update_from_markdown` has no way to produce a Yjs state vector without shipping Yjs into its runtime. More importantly, `fetchedBlocks[]` cannot be materialised from a state vector alone — a state vector is a vector-clock summary, not a serializable snapshot of block content. Reconcile needs the **block array as it existed at fetch time** as the baseline for three-way merge; the server must retain that baseline itself and hand the caller an opaque handle.

Flow:

```
doc.update_from_markdown({
  workspace_id, doc_id, markdown,
  reconcile_base_token: string,                   // F66/F73 — opaque server-issued handle
                                                  //   required in mode="reconcile" and "strict"
                                                  //   optional in mode="replace"
  mode: "reconcile" | "replace" | "strict",       // F37 — default "reconcile"
  allow_foreign_ids?: boolean                     // F44 — default false
}):
  1. Parse markdown → mdast (remark-parse + remark-directive, pinned).
  2. mdast → incomingBlocks[] via per-type fromMarkdown (ADR 0013).
  3. Resolve reconcile_base_token →
       { fetchedBlocks[], fetchedStateVector } from `reconcile_bases` (§3.18).
     If token is missing / expired / not found for this (workspace_id, doc_id):
       throw ConflictError("stale_fetch", { max_reconcilable_age_ms }).
     Caller re-runs doc.get_markdown to obtain a fresh token.
  4. In ctx.transact(doc_id, editor => { … }):
       a. Read live_state_vector = Y.encodeStateVector(editor.yDoc).
          Read currentBlocks[] from the editor.
       b. ops = reconcileBlocks(fetchedBlocks, currentBlocks, incomingBlocks, mode, allow_foreign_ids)
       c. for each op: editor.applyOp(op)
       d. return { ops_applied, diagnostics }
```

`doc.get` and `doc.get_markdown` return `reconcile_base_token` alongside content. The token identifies a server-retained snapshot in `reconcile_bases` (§3.18); TTL is `max(72h, tombstone_retention_floor)` — the same floor as `doc_updates` reaper (ADR 0007) so a restore that can reach the journal can also reach the baseline. Token issuance is recorded as an `AuditEffect` variant (`doc.reconcile_base_token` — transient, so GC activity is auditable). A dedicated reaper batch `"reconcile_bases"` (§3.14, §13) drops expired tokens.

**Ergonomics (F65).** Simple HTTP agents that `curl`'d markdown get the token back in the response and pass it verbatim — no Yjs machinery on the client, no state-vector production. The token is an opaque string as far as the caller is concerned.

Reconcile contract (v1):

- **Block ID is load-bearing.** Agents that expect stable round-trip must preserve block IDs in the markdown they emit (HTML comment for lossless; directive attribute for directive/opaque — ADR 0013 §block-ids). If an `incoming` block carries an ID matching a `current` block **and** the block types match, `reconcile` emits an `update`, never a `remove+insert`.
- **Orphans are preserved, not removed, in `mode=reconcile`.** A block present in `current` but not in `incoming` (no matching ID) is **kept** — this prevents the silent-clobber race where human keystrokes land between markdown-fetch and markdown-apply.
- **Move, not remove+insert (F33).** If an ID matches between `current` and `incoming` and the block's parent or adjacency has changed, reconcile emits `{ op: "move", block_id, new_parent_block_id, new_order_key }` — not a remove+insert pair. This preserves comment anchors and attachment refs targeting that block.
- **Three modes (F37):**
  - `reconcile` (default): concurrent-edit safe. At the start of the transact, reconcile compares the `fetchedStateVector` resolved from the token with `live_state_vector`.
    - Identical → proceed with the straight three-way merge.
    - Different → for each ID present in both `incoming` and `current` where `current[id]` differs from `fetched[id]`, treat as conflict. Default: **preserve `current[id]` (human/last-writer wins)**, surface the block id in the returned `diagnostics.conflicts[]`, do NOT emit `update` for that block. Emit `update` only for blocks in `incoming` that were unchanged in `current` since fetch.
  - `strict`: throws `ConflictError` on any concurrent change since fetch. For agents that must refuse to land edits if humans moved.
  - `replace`: clobber mode — reconcile emits `remove` for any block not in `incoming`. Intent is explicit; accident is not possible. `reconcile_base_token` is optional in this mode.
- **Unknown-origin IDs are defensively handled (F44).**
  - `incoming` block with ID X that does not exist in `current` → treat as `insert` with a **fresh ID** (not the claimed X); the mapping is returned in `diagnostics.remapped_ids[]`. Operators who trust the agent can opt in via `allow_foreign_ids: true` to preserve claimed IDs; default is `false`.
  - `incoming` block with ID X matching `current` but with a **mismatched `type`** (e.g., `current[X].type=paragraph`, `incoming[X].type=heading`) → treat as `remove + insert-with-new-id`, returned in `diagnostics.type_shifted[]`. Intent-preserving; blocks cross-block hijack attempts.
- **In-flight concurrent writes.** Before the transact commits, reconcile compares `live_state_vector` (captured at step 4a) to the current state vector. If they differ (meaning another update landed on the same doc inside the transact), reconcile **retries the diff** against the new `current` up to 3 times, then throws `ConflictError`. Caller retries the whole capability.

Property tests:

- `reconcile.prop.ts` asserts — for fuzzed `(fetchedBlocks, currentBlocks, incomingBlocks, concurrent_human_edits_during_parse)` — in `mode=reconcile`, a human's concurrent insert is never removed and a block edited by the human between fetch and apply retains the human's edit (diagnostics list the conflict).
- `reconcile-foreign-ids.prop.ts` asserts — reconcile applied to markdown with fabricated IDs produces fresh-ID blocks, never updates of existing blocks, when `allow_foreign_ids=false`.
- `reconcile-base-token-ttl.prop.ts` asserts — expired token → `ConflictError("stale_fetch")`; token valid + concurrent human edit → human wins on overlap; token valid + no concurrent edit → agent applies cleanly.

## 7. Read path / projections

Reads never touch the write path. They project from the Y.Doc (or a cached projection):

| Projection | Freshness | Consumer |
|---|---|---|
| Block array JSON | real-time via Y.Doc | editor, `doc.get`, MCP resource |
| Rendered Markdown | computed on demand, cached per-snapshot | public render, mirror, MCP resource |
| Rendered HTML (published) | per-snapshot, cached | `(public)` route |
| `blocks` table rows | debounced (~250 ms post-onChange) | FTS, list queries, mirror |
| Embeddings | per-block async (ADR 0008) | semantic search |
| FTS index | per-block async | keyword search |
| Doc title | per-snapshot | listings |

Cache invalidation: every `onChange` emits a `doc.invalidated` event keyed by `{doc_id, snapshot_seq}`; consumers listen and invalidate their caches.

## 8. Permission model

### 8.1 Three-layer enforcement (ADR 0015)

```
Layer 1 — Capability dispatch
  dispatcher resolves Principal → evaluates requires against
  (role_default ⊕ workspace_override ⊕ collection_acls ⊕ doc_acls) →
  agentAllowed / humanOnly flags checked →
  scopes intersected (agent.scopes ∩ human.permissions when acting_as) →
  allow | deny (+ audit row for deny)

Layer 2 — TenantScopedDb (Kysely wrapper + AsyncLocalStorage)
  every query against a tenant-scoped table auto-injects
  workspace_id = ctx.workspace_id; build-time type error
  + runtime assertion if a TenantContext is missing.

Layer 3 — Postgres RLS (Postgres mode only)
  SET app.workspace_id on connection checkout;
  every tenant-scoped table has a policy USING (workspace_id = current_setting('app.workspace_id')).
```

SQLite mode has Layer 1 + 2; Postgres mode adds Layer 3 as a database-level backstop.

### 8.1a SQLite hardening — Layer-2-as-floor (F4 fix)

SQLite has no RLS. Layer 2 (`TenantScopedDb`) is the last line of defense. That's adequate only if Layer 2 is **actually unbypassable**, and that requires more than a wrapper — it requires:

- **Architecture lint rule `no-raw-kysely-outside-db`:** `Kysely`, `sql<T>` raw template, and `db.connection()` are importable only inside `packages/db/**`. Anywhere else, an import failure at pre-commit. Today this is enforced by `scripts/coherence.ts` via import-string grep; when `@editorzero/arch-lint` ships (F89) the rule moves to a proper static check, but the invariant is gated from day one. Capabilities and services reach the DB through `ctx.db` (a `TenantScopedDb`) or through `dbRepo.<method>` (which internally uses `TenantScopedDb`).
- **`OpsDb` escape hatch is opt-in, audited, and enumerated.** `OpsDb` is a distinct type that requires a `@ops-audited("reason")` decorator at the call site. The planned `ops-db-audit` rule in `@editorzero/arch-lint` will fail the commit on an un-audited construction once the package ships (F89 — not yet implemented; discipline + review today). Each legitimate use site is listed in `ops/ops-db-registry.md` with owner + rationale.
- **Cross-tenant leak fuzzer is a first-class invariant test.** `packages/db/test/tenant-isolation.prop.ts` runs against **both** SQLite and Postgres drivers: for every `(capability, principal_workspace, target_workspace)` combination, assert that no tenant-scoped row from `target_workspace ≠ principal_workspace` is reachable through any capability call. Default fuzz: 1k rounds per driver per commit; 100k nightly.
- **Postgres RLS is enabled-by-default on Postgres mode** but verified the same way the fuzzer verifies SQLite. The fuzzer's invariant is stronger than RLS — it also asserts that the capability returns the correct result, not merely zero rows.

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
4. Layer 2 never reached. (If Layer 1 were bypassed, Layer 2's query would still scope to A and return empty. Layer 3 RLS would also return empty.)

#### (b) Public publish strips internal blocks

Alice runs `doc.publish(doc_id=D)` on a doc with some `block.visibility='internal'` rows.

1. Dispatcher checks `Alice` has `doc:publish` on D. Allowed.
2. Handler: sets `docs.visibility='public'`, `published_at=now()`. Enqueues `projection_blocks` job.
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

#### Invariant 3b — CRDT state is reproducible from snapshots + updates

> For any doc D and any snapshot_seq S: applying `doc_snapshots[D].latest_before(S)` followed by `doc_updates[D, seq ∈ (snapshot_seq, S]]` in seq order produces a Y.Doc equal to the live Y.Doc after every accepted update ≤ S.

Proven by `packages/sync/test/crdt-durability.prop.ts`: fuzz N random update sequences; checkpoint; simulate crash; rehydrate; diff.

Together 3a + 3b reconstruct the full workspace state. Neither alone is sufficient; both hold.

### 9.2 `AuditEffect` is load-bearing for invariant 3a

Effects must be **sufficient to replay the persistent-state change**, not merely sufficient to identify it. Red-team F1 demanded explicit fixes:

- `block.*` effects that mutate projected state carry the full post-projection block JSON *on top of* the CRDT update (which is the authoritative store). The audit reducer for projected-state rebuilds `blocks` row from the effect; the CRDT content itself is a separate invariant (3b).
- `doc.purge` carries the full **preimage** of the doc — not just a sha256. The purge effect's body includes the block array projection and the snapshot_seq at purge time, which together feed the 24h restore-token escape hatch (ADR 0017 §hard-delete).
- `block.update` effects use `post` (full block JSON after the update) — not `patch`. Patches can't be composed deterministically across fuzz fixtures; full post-state can.

The precise `AuditEffect` discriminated union lives in [§16.3](#163-typed-primitives).

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

## 11. Search

### 11.1 Indexing pipeline

```
projection_blocks job (outbox → debounced 250 ms per doc):
  → rebuild blocks rows (content_text, content_json) for changed blocks
  → emit block.changed events into outbox for each mutated block

embed job (per block.changed event):
  → load block.content_text
  → ONNX (current active model) → float[D]
  → UPSERT blocks_vec (SQLite) / UPDATE blocks.embedding (Postgres)
    with embedding_model_version = current_active_version

(Note: search_reindex is not a separate queue — FTS is a virtual table updated
 in the same tx as blocks projection; vector updates are embed job output.)
```

### 11.2 Query — with visibility scoping (F17 fix)

`search.query({workspace_id, q, filters, limit})`:

```
bm25 = driver.bm25Candidates(workspace_id, q, limit * 3, visibility_filter)
vec  = embed(q); vector = driver.vectorCandidates(workspace_id, vec, limit * 3, visibility_filter)
fused = rrf(bm25, vector, k=60)[:limit]
snippets = driver.snippets(fused_ids, q, visibility_filter)   // redaction at snippet time too
return fused.map(f => { doc_id, block_id, score, snippet })
```

`visibility_filter` is computed from `Principal`:

- Anonymous / public-route reader (the `(public)` surface): `visibility IN ('default','public')`.
- Workspace member: `visibility IN ('default','public','internal')` (internal visible to members).
- Denied-block case (sparse `doc_acls` deny): excluded from candidates at query time.

Tenant-scoping enforced by TenantScopedDb (Layer 2) + RLS (Layer 3 on Postgres).

### 11.3 Embedding model swap — atomic flip (F30 fix)

Model swap (e.g., switching from `bge-small-en-v1.5` to `bge-m3` for multilingual) is not a global reindex-then-swap; it's **dual-write then atomic flip**:

```
admin.reembed_workspace({ workspace_id, target_model, target_model_version }):
  1. Record new version in `embedding_models(workspace_id, version, name, dim, status='indexing')`.
  2. Enqueue one embed job per block, writing to `embeddings_next`
     (a separate table on both drivers, same shape as blocks_vec).
  3. Progress gauge: `embed_progress{workspace_id,version}` on /metrics.
  4. When all blocks embedded, dispatcher runs an atomic swap inside one DB tx:
        UPDATE embedding_models SET status='active' WHERE workspace_id AND version=target
        UPDATE embedding_models SET status='archived' WHERE workspace_id AND status='active' AND version!=target
        (SQLite: ATTACH blocks_vec_next AS blocks_vec; reverse on old.
         Postgres: ALTER INDEX blocks_hnsw_idx RENAME TO blocks_hnsw_idx_old;
                   ALTER INDEX blocks_hnsw_idx_next RENAME TO blocks_hnsw_idx.)
  5. Query path reads the `status='active'` version only; old version is archived
     (kept for 24h grace in case of rollback).
```

During reindex, `search.query` returns old-model results at full recall (queries use old embeddings; old index untouched). After flip, queries use new model. **No query sees mixed old+new results.** Property test `search-reindex-flip.prop.ts`: nDCG@10 never drops below baseline during reindex.

### 11.4 Memory budgets (F39)

Operators plan RAM for vector search before provisioning; Phase 3 must preflight rather than discover.

**Postgres / pgvector (declared):**

- HNSW `m=16, ef_construction=64` on `float[384]` at 1M rows uses ~3 GB RAM resident. Operator-advertised baseline.
- **Reindex doubles the memory window.** During the `admin.reembed_workspace` dual-write phase (§11.3) both the active and the `_next` indexes are resident: 2× peak, ≈ 6 GB for a 1M-row workspace.
- **Required Postgres settings:**
  - `maintenance_work_mem ≥ 2 × expected_index_size` during reindex.
  - `shared_buffers ≥ 1.5 × steady_state_index_size` for the hot index.
- **Preflight in `admin.reembed_workspace`:** refuse to start if `maintenance_work_mem < 2 × current_index_size`; return `ResourceLimitError` with the actionable message (`set maintenance_work_mem to ≥ N MB and restart`).
- **Observability:** `blocks_hnsw_idx` size is surfaced on `/admin/observability`; alert if peak reindex memory forecast exceeds available RAM.

**SQLite / sqlite-vec (brute force):**

- Memory ≈ `count × dim × 4 bytes`. At 1M × 384 dims: ~1.5 GB — already memory-heavy without an ANN index.
- Above **~500k embeddings**, migrate to Postgres. The admin dashboard nags at that threshold; `admin.reembed_workspace` refuses on SQLite above 1M unless `--force` is passed.

## 12. Jobs

Every `JobService` call flows through the shared interface (ADR 0014). Queues:

| Queue | Trigger | Retry / Backoff | Notes |
|---|---|---|---|
| `outbox_forwarder` | outbox insert | 3× exp | Reads `outbox` rows, enqueues downstream jobs. At-least-once. |
| `projection_blocks` | outbox `doc.updated` (debounced 250 ms per doc) | 3× exp 2s..30s | Rebuilds `blocks` from Y.Doc. Idempotent on `snapshot_seq`. |
| `embed` | outbox `block.changed` | 5× exp 5s..5m | ONNX inference; writes to current or _next table during reindex |
| `mirror.project_doc` | outbox `doc.updated` (debounced per `mirror_configs.debounce_ms`) | 5× exp | Renders Markdown, commits. Idempotent on `(doc_id, snapshot_seq)`. |
| `mirror.push` | batched from `mirror.project_doc` per `mirror_configs.batch_window_ms` | 5× with `--force-with-lease` | Push to remote |
| `mirror.reconcile` | cron every 5 min | none | (F11) Walks `docs` where `latest_snapshot_seq > mirror_state.last_snapshot_seq`; enqueues `mirror.project_doc`. Catches up after crashes or misconfig. |
| `reaper` | cron nightly | none | GC tombstoned doc_updates, expired soft-deletes, pending_delete attachments, orphan uploads (F80), expired reconcile_bases (F66/F73) |
| `compaction` | Hocuspocus triggers when thresholds hit (ADR 0007) | none | Snapshot + tombstone |
| `webhook` | outbox `audit.appended` (filtered by `webhooks.events` per workspace) | 3× exp 1s/5s/30s; 10s HTTP timeout; 20 consecutive fails → circuit-break | At-least-once; HMAC-signed; DNS-pinned; SSRF-rejected at create (F46; §3.17) |
| `email` | various | 5× | via configured SMTP / SES / Resend |
| `dcr_cleanup` | cron daily | none | Delete DCR clients unused > 90 days (ADR 0009) |
| `restore_search` | `doc.restore` | 3× | Rebuild search for restored doc |
| `purge` | `doc.purge` / `workspace.purge` | 3× | Hard-delete cascade |

Observability (ADR 0019): per-queue depth gauge, oldest-pending-age histogram, per-job span, ceiling-breach alert on SQLite driver.

## 13. Mirror (git + S3)

### 13.1 Pipeline

```
doc.updated outbox event (post-write-path tx)
  → outbox_forwarder enqueues mirror.project_doc if mirror_configs.enabled

mirror.project_doc(workspace_id, doc_id, snapshot_seq)
  → load snapshot at snapshot_seq
  → render per ADR 0013 (lossless/directive/opaque) → Markdown + frontmatter
  → UPSERT <mirror path>/<collection>/<slug>.md in the worker's working-tree clone
  → commit with attribution split (author=principal, committer=mirror bot)
  → UPDATE mirror_state SET last_snapshot_seq, last_export_at, last_commit_sha

mirror.push (batched per workspace every batch_window_ms)
  → push editorzero-mirror branch with --force-with-lease
  → on rate-limit: honor Retry-After, exp backoff
  → on sustained failure: circuit-break, admin notification

mirror.reconcile (cron every 5 min, F11 fix)
  → SELECT docs WHERE mirror_state.last_snapshot_seq < docs.latest_snapshot_seq
  → for each lagging doc: enqueue mirror.project_doc
  → runs independent of outbox; catches docs missed by crashes, outbox-forwarder lag,
     or misconfig (mirror enabled after a doc's last edit)
```

Idempotency: a `mirror.project_doc` for a `(doc_id, snapshot_seq)` where `mirror_state.last_snapshot_seq >= snapshot_seq` is a no-op. The reconciler therefore cannot cause double-writes.

### 13.2 Attributions

Commit author = the principal that triggered the change. Commit committer = always the mirror bot. Agent-authored commits carry `Co-authored-by: <human>` if `acting_as`. Format exactly per GitHub's Copilot Coding Agent convention (ADR 0020).

### 13.3 S3 archive

Same pipeline, different sink: `s3://<bucket>/<workspace>/<collection>/<doc_id>.md`. Versioning enabled on the bucket; lifecycle rules user-configured.

## 14. OpenAPI surface (derived, not authored)

Per Nomi's directive + ADR 0009: OpenAPI is **generated at runtime** from the capability registry, not hand-authored.

### 14.1 Generator

```
packages/api-server/src/openapi.ts
  → iterate capabilities
  → for each capability where surface includes HTTP:
      create a route using @hono/zod-openapi's createRoute with
        method, path, security (scopes), request schema, response schemas
  → expose:
      GET /api/v1/openapi.json   (live generated spec)
      GET /api/v1/docs           (Scalar / Rapidoc viewer)
```

### 14.2 Drift detection

A CI contract test snapshots the generated spec to `packages/api-server/openapi.snapshot.json`. A PR that changes the spec without updating the snapshot fails. Intentional changes commit the new snapshot. This gives us the one thing a static spec gives (diff-review of breaking changes) while the source of truth stays in code.

### 14.3 Security schemes

- `sessionCookie` — Better Auth session, browsers (same-origin fetch from the Vite SPA; `SameSite=Lax`, ADR 0030).
- `bearerToken` — API keys (human PAT) and agent API-keys (`@better-auth/api-key`).
- `oauth2` — OAuth 2.1 with DCR + PKCE S256; scopes from capability `requires` vocabulary.

### 14.4 Endpoints outside the registry

Thin pass-throughs, all covered by other ADRs:
- `POST /api/auth/*` — Better Auth mount.
- `GET /.well-known/oauth-protected-resource` — RFC 9728 (ADR 0009).
- `GET /.well-known/oauth-authorization-server` — OAuth discovery.
- `GET /metrics` — Prometheus.
- `GET /api/healthz` — health.

## 15. MCP capability surface (draft)

### 15.1 Derivation

Same registry → MCP tools (per ADR 0009):

*[Realised in slice 1 by `packages/mcp-server` — `createMcpHandler({ registry, dispatcher, serverInfo })` returns a Hono handler the trunk mounts at `/mcp` behind the same principal middleware `/docs/*` uses (cookie auth, transitional). The actual filter is `isMcpTool(cap)` (`cap.surfaces.includes("mcp") && cap.humanOnly !== true`), not the `category !== "admin"` shown in the pseudocode below; ADR 0026 documents the six load-bearing commitments — principal via Hono chain, deliberately stateless, registry → tool loop, three-way error cut, `humanOnly` structural filter, no slice-1 OAuth discovery. `outputSchema` is not published in slice 1; outputs travel as JSON in `content[0].text`. Contract-matrix parity at the adapter and trunk layers is enforced by `packages/mcp-server/src/create-mcp-handler.integration.test.ts` and `packages/api-server/src/composition/mcp-chain.integration.test.ts`.]*

```
packages/mcp-server/src/index.ts
  import { capabilities } from "@editorzero/capabilities";
  for (const cap of capabilities) {
    if (cap.surfaces.includes("mcp") && cap.category !== "admin") {
      server.registerTool({
        name: cap.id,                    // "doc.update"
        description: cap.summary,
        inputSchema: cap.input,          // zod v4
        outputSchema: cap.output,
        handler: async (input, mcpCtx) => {
          const principal = await resolvePrincipal(mcpCtx.auth);
          return dispatcher.invoke(cap.id, { principal, tenant }, input);
        },
      });
    }
  }
```

### 15.2 Resources

Read-side only. Each resource is backed by a read capability:

| URI template | Handler |
|---|---|
| `editorzero://workspace/{id}/doc/{id}` | `doc.get` → Markdown per ADR 0013 |
| `editorzero://workspace/{id}/doc/{id}/blocks` | `doc.get` → block array JSON |
| `editorzero://workspace/{id}/doc-tree` | `collection.list` + `doc.list` joined |
| `editorzero://workspace/{id}/schema` | static: block-type schema (for agent authoring) |

### 15.3 Toolsets

Grouped via `X-MCP-Tools` header; declared in the registry via `cap.tags: ["read", "write", "admin"]`. `--read-only` mode filters category=`read`.

### 15.4 Session lifecycle (ADR 0009)

- Keepalive SSE every 15s.
- `Mcp-Session-Id` + `Last-Event-Id` for resume.
- `tool_call_id` persisted 24h for interrupted calls: `GET /mcp/tool-calls/{id}` returns status/result.
- Revocation: Better Auth revokes credential → MCP session manager closes bound sessions (ADR 0016).

### 15.5 Prompts (deferred)

Capability registry has a prompts extension point; not populated in MVP. A user who wants templated authoring (`"draft a meeting-notes doc from these talking points"`) gets a resource-backed template. Real deliverable in Phase 4+.

## 16. Engineering primitives for agentic workflows

This section specifies **how the repo is organized so coding agents (and disciplined humans) land high-quality, non-regressing changes at speed**. It is the operational instantiation of [§1.1 Design posture](#11-design-posture--engineering-for-coding-agents).

### 16.1 Monorepo layout

pnpm workspaces, single root `tsconfig.json` with project references, single `package.json` for dev deps, per-package `package.json` for runtime deps.

```
editorzero/
├── apps/
│   ├── app/                       # Vite + React SPA (ADR 0027/0028) — editor UI
│   ├── admin/                     # operator console, gated (SPA)
│   └── cli/                       # Bun-compiled CLI from registry (ADR 0021)
├── packages/
│   ├── ids/                       # Branded ID types + parsers (no runtime deps)
│   ├── scopes/                    # Scope vocabulary + helpers
│   ├── principal/                 # Principal type + resolve()
│   ├── audit/                     # AuditEffect union + writer interface
│   ├── capabilities/              # THE registry — one file per capability
│   │   ├── src/
│   │   │   ├── kernel.ts          #   Capability<I,O> + CapabilityContext types
│   │   │   ├── registry.ts        #   barrel: Map<CapabilityId, Capability>
│   │   │   ├── doc/
│   │   │   │   ├── update.ts      #   implements "doc.update"
│   │   │   │   ├── update.unit.test.ts
│   │   │   │   ├── create.ts
│   │   │   │   └── …
│   │   │   ├── workspace/…
│   │   │   └── …
│   │   └── package.json
│   ├── dispatcher/                # Auth + permission + rate-limit + audit + span
│   ├── auth/                      # Better Auth config + plugin wiring (infra)
│   ├── auth-service/              # Service-layer wrappers (F28): resolveSession,
│   │                              #   revokeAgent, rotateToken, issueAgentKey, etc.
│   │                              #   Capabilities import from here, not from `auth`.
│   ├── db/                        # Kysely + Atlas migrations + TenantScopedDb
│   │   ├── src/
│   │   │   ├── schema/            #   .sql files; Atlas-managed
│   │   │   ├── generated/         #   kysely-codegen output; committed
│   │   │   ├── tenant.ts          #   TenantScopedDb wrapper + AsyncLocalStorage
│   │   │   └── repos/             #   repository layer — one file per aggregate
│   │   │       ├── docs.ts        #   docRepo.findById, docRepo.insert, …
│   │   │       └── …
│   │   └── …
│   ├── sync/                      # Hocuspocus integration + ctx.transact impl
│   ├── blocks/                    # Block specs (ADR 0013) — one file per block type
│   │   ├── src/
│   │   │   ├── kernel.ts          #   BlockTypeSpec<Attrs, …> type + tier union
│   │   │   ├── core/
│   │   │   │   ├── heading.ts     #   editorzero:core/heading
│   │   │   │   ├── heading.prop.test.ts
│   │   │   │   └── …
│   │   │   └── directive/…
│   ├── search/                    # SearchService + FTS + vector drivers
│   ├── jobs/                      # JobService + pg-boss + SQLite drivers
│   ├── mirror/                    # git + S3 sinks + projection pipeline
│   ├── mcp-server/                # MCP derivation from registry (ADR 0026)
│   ├── api-server/                # Hono routes from registry + OpenAPI gen (ADR 0021)
│   ├── api-client/                # Typed-RPC client via `hc<AppType>` (ADR 0021)
│   ├── observability/             # OTel SDK + shared tracer/logger/meter
│   ├── contract-tests/            # Cross-surface parity matrix (generated)
│   └── e2e/                       # Playwright + axe
├── ops/
│   ├── docker/                    # Dockerfile + compose.yaml
│   ├── grafana/                   # Dashboards
│   └── scripts/                   # one-shot operator tools
├── docs/                          # ADRs, architecture, runbook, threat model
└── .github/                       # OSS hygiene
```

**Package boundaries are contracts.** A package's public exports are its `index.ts` barrel; anything not exported is private. Cross-package imports go through the barrel, never deep paths. Enforced by a Biome rule.

### 16.2 Layered architecture (per package, and across them)

Import direction is strictly downward. Higher layers import from lower; never the reverse.

```
  ┌───────────────────────────────────────────────┐
  │ Surface adapters (api-server, cli,            │
  │ mcp-server, app — the Vite SPA)               │   Adapters only.
  └───────────────────┬───────────────────────────┘   No business logic.
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Capability layer (packages/capabilities)      │   Declarative: shape +
  │   one Capability<I,O> per mutation or read    │   handler calling services.
  └───────────────────┬───────────────────────────┘
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Dispatcher (packages/dispatcher)              │   Cross-cutting:
  │   resolve principal, permission check,        │   auth, permission,
  │   rate limit, audit write, span               │   rate, audit, span.
  └───────────────────┬───────────────────────────┘   Unknown to services.
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Service layer (per-domain packages: docs,     │   Business logic.
  │ search, mirror, jobs)                         │   Pure functions over
  │   services take typed inputs, return typed    │   repo + primitives.
  │   outputs, call repos, never surfaces         │   Single responsibility.
  └───────────────────┬───────────────────────────┘
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Repository layer (packages/db/repos)          │   Persistence only.
  │   Kysely queries via TenantScopedDb           │   No business logic.
  │   return typed domain rows                    │   One repo per aggregate.
  └───────────────────┬───────────────────────────┘
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Infrastructure (packages/db, sync, auth,      │   Framework adapters.
  │ observability, jobs drivers)                  │   Thin; wrap vendor APIs.
  └───────────────────────────────────────────────┘
```

The surface-adapters box includes `api-server` / `mcp-server` at `packages/*` and `apps/cli` / `apps/app` (Vite SPA) per ADR 0021/0027. `api-client` (typed-RPC client via `hc<AppType>`) is not a surface adapter itself — it rides alongside `api-server` for consumers, so it sits at the capability-layer boundary rather than in this diagram. Lint rules derived from this section will crystallize as a dedicated `@editorzero/arch-lint` package when it lands.

**Layer import rules (enforced by Biome + custom tsmorph lint):**

- `capabilities/*` may import from: `ids`, `scopes`, `principal`, `audit`, `auth-service`, domain-service packages, `dispatcher` (for types only).
- `capabilities/*` may **not** import from: `db` (use `ctx.db`), `sync` (use `ctx.transact`), `auth` (use `auth-service`), `api-server`, `mcp-server`, `apps/*` (CLI + Web UI SPA). Business logic lives in services, not handlers.
- Service packages (including `auth-service`) may import from: `ids`, `scopes`, `principal`, `db/repos`, infrastructure (`auth`, `sync`, `observability`), sibling service packages (sparingly, document in the import). May **not** import from: any surface package, `dispatcher`, `capabilities`.
- Repo packages (`db/repos/*`) may import from: `db` (Kysely) only. May **not** import services, capabilities, surfaces.
- Surface adapters may import from: `capabilities/registry`, `dispatcher`. Never services or repos directly.
- `auth` (infra) may import from: Better Auth primitives, `db` (to mount Kysely adapter). May **not** be imported by `capabilities` or any service layer except `auth-service`.

A PR that violates a layer rule fails the pre-commit lint.

### 16.3 Typed primitives

#### Branded IDs (`packages/ids`)

```ts
export type Branded<T, B> = T & { readonly __brand: B };
export type WorkspaceId  = Branded<string, "WorkspaceId">;
export type UserId       = Branded<string, "UserId">;
export type AgentId      = Branded<string, "AgentId">;
export type DocId        = Branded<string, "DocId">;
export type BlockId      = Branded<string, "BlockId">;
export type CollectionId = Branded<string, "CollectionId">;
export type CapabilityId = Branded<string, "CapabilityId">;
export type SessionId    = Branded<string, "SessionId">;
export type TokenId      = Branded<string, "TokenId">;
export type JobId        = Branded<string, "JobId">;
export type MirrorId         = Branded<string, "MirrorId">;         // F50
export type CustomDomainId   = Branded<string, "CustomDomainId">;   // F50
// parsers validate format (UUIDv7) and cast; single entry point per type
export const WorkspaceId = (s: string): WorkspaceId => { /* validate */ return s as WorkspaceId; };
// …etc
```

Handlers accept branded IDs, not `string`. Passing the wrong ID is a compile error.

#### String-literal unions

```ts
export type Scope = "doc:read" | "doc:write" | "doc:delete" | "doc:publish"
                  | "block:read" | "block:write"
                  | "comment:read" | "comment:write" | "comment:resolve"
                  | "search:read"
                  | "workspace:read" | "workspace:admin"
                  | "permission:grant" | "permission:revoke"
                  | "agent:create" | "agent:revoke"
                  | "admin";
export type CapabilityCategory = "mutation" | "read" | "auth" | "admin" | "system";
export type FidelityTier = "lossless" | "directive" | "opaque";
export type QueueName = "projection_blocks" | "embed" | "search_reindex"
                      | "mirror.project_doc" | "mirror.push" | "mirror.reconcile"
                      | "reaper" | "compaction" | "webhook" | "email"
                      | "dcr_cleanup" | "restore_search" | "purge"
                      | "outbox_forwarder";
export type PrincipalKind = "user" | "agent";
export type SubjectKind = "workspace" | "collection" | "doc" | "block"
                        | "comment" | "attachment" | "agent" | "user"
                        | "token" | "mirror" | "system";
```

Every `switch` on these is exhaustiveness-checked (`satisfies never` in the default arm).

#### Discriminated unions

```ts
export type Principal =
  | { kind: "user";  id: UserId;  workspace_id: WorkspaceId; roles: Role[];
      session_id: SessionId | null; token_id: TokenId | null }
  | { kind: "agent"; id: AgentId; workspace_id: WorkspaceId;
      owner_user_id: UserId | null; scopes: Scope[]; token_id: TokenId;
      token_kind: "agent-auth" | "api-key"; acting_as?: UserId };

// Canonical block post-state — what ends up in the blocks projection.
// NOT the Yjs binary update (that lives in doc_updates, invariant 3b).
export interface BlockPostState {
  id: BlockId;
  doc_id: DocId;
  type: string;
  parent_block_id: BlockId | null;
  order_key: string;
  content_json: unknown;
  visibility: "default" | "internal" | "public";
}

export interface DocPurgePreimage {
  doc_id: DocId;
  title: string;
  collection_id: CollectionId | null;
  visibility: "workspace" | "public" | "private";
  blocks: BlockPostState[];                // full block array at purge time
  snapshot_seq_at_purge: number;           // for forensics; the snapshot itself is gone
}

// AuditEffect carries everything needed to replay PersistentWorkspaceState
// (invariant 3a). See §9.1 / §9.2.
export type AuditEffect =
  // Lifecycle ---------------------------------------------------------------
  | { kind: "workspace.create"; workspace_id: WorkspaceId; slug: string; name: string; created_by: UserId }
  | { kind: "workspace.update"; workspace_id: WorkspaceId; patch: Partial<{ name: string; trash_retention_days: number; settings: unknown }> }
  | { kind: "workspace.soft_delete"; workspace_id: WorkspaceId }
  | { kind: "workspace.restore";     workspace_id: WorkspaceId }
  | { kind: "workspace.purge";       workspace_id: WorkspaceId; member_count_at_purge: number }
  | { kind: "member.add";    workspace_id: WorkspaceId; user_id: UserId; role: Role }
  | { kind: "member.remove"; workspace_id: WorkspaceId; user_id: UserId }
  | { kind: "member.update_role"; workspace_id: WorkspaceId; user_id: UserId; role: Role }
  // Collection --------------------------------------------------------------
  | { kind: "collection.create"; collection_id: CollectionId; workspace_id: WorkspaceId; parent_id: CollectionId | null; title: string; slug: string; order_key: string }
  | { kind: "collection.update"; collection_id: CollectionId; patch: Partial<{ title: string; slug: string; order_key: string }> }
  | { kind: "collection.move";   collection_id: CollectionId; new_parent_id: CollectionId | null; new_order_key: string }
  | { kind: "collection.soft_delete"; collection_id: CollectionId }
  | { kind: "collection.restore";     collection_id: CollectionId }
  // Doc ---------------------------------------------------------------------
  | { kind: "doc.create"; doc_id: DocId; workspace_id: WorkspaceId; collection_id: CollectionId | null; title: string; slug: string; order_key: string; visibility: "workspace"|"public"|"private"; seed_blocks: SeedBlock[] }  // seed_blocks = pre-minted BlockIds + shape for replay reconstruction (invariant 3a)
  | { kind: "doc.rename"; doc_id: DocId; title: string }
  | { kind: "doc.move";   doc_id: DocId; new_collection_id: CollectionId | null; new_order_key: string }
  | { kind: "doc.publish";   doc_id: DocId; published_at: number }
  | { kind: "doc.unpublish"; doc_id: DocId }
  | { kind: "doc.soft_delete"; doc_id: DocId }
  | { kind: "doc.restore";     doc_id: DocId }
  | { kind: "doc.purge"; preimage: DocPurgePreimage }        // full preimage for restore token + audit replay
  | { kind: "doc.reconcile_base_token"; doc_id: DocId; token: string; expires_at: number }  // F66/F73: transient; GC is auditable
  // Block (projection state; CRDT content is invariant 3b) ------------------
  | { kind: "block.insert"; doc_id: DocId; post: BlockPostState }
  | { kind: "block.update"; doc_id: DocId; post: BlockPostState }   // full post-state, not patch
  | { kind: "block.remove"; doc_id: DocId; block_id: BlockId }
  | { kind: "block.set_visibility"; doc_id: DocId; block_id: BlockId; visibility: "default"|"internal"|"public" }
  // doc.update batch (F12 + F33): one audit row per handler invocation ------
  | { kind: "doc.update_batch"; doc_id: DocId; ops: Array<
        | { op: "insert"; block: BlockPostState; after_block_id: BlockId | null; parent_block_id: BlockId | null }
        | { op: "update"; block_id: BlockId; post: BlockPostState }
        | { op: "move";   block_id: BlockId; new_parent_block_id: BlockId | null; new_order_key: string }
        | { op: "remove"; block_id: BlockId; preimage: BlockPostState }
        | { op: "set_visibility"; block_id: BlockId; visibility: "default"|"internal"|"public" }
      > }
  // Version -----------------------------------------------------------------
  | { kind: "version.create";  doc_id: DocId; version_id: string; name: string | null; snapshot_seq: number }
  | { kind: "version.restore"; doc_id: DocId; from_version_id: string; pre_restore_version_id: string; snapshot_seq_before: number; snapshot_seq_after: number }
  // Comment / attachment ----------------------------------------------------
  | { kind: "comment.create"; comment_id: string; doc_id: DocId; anchor: unknown; thread_root_id: string | null; body_markdown: string }
  | { kind: "comment.update"; comment_id: string; body_markdown: string }
  | { kind: "comment.resolve"; comment_id: string; resolved_by: UserId | AgentId }
  | { kind: "comment.soft_delete"; comment_id: string }
  | { kind: "attachment.request_upload"; upload_id: string; workspace_id: WorkspaceId; storage_key: string; declared_size: number; declared_content_type: string; declared_sha256: string | null; expires_at: number }   // F57/F80
  | { kind: "attachment.confirm_upload"; upload_id: string; attachment_id: string; storage_key: string; filename: string; content_type: string; bytes: number; sha256: string }                                         // F57/F80
  | { kind: "attachment.soft_delete"; attachment_id: string }
  // Permissions -------------------------------------------------------------
  | { kind: "acl.grant";  scope: { doc_id: DocId } | { collection_id: CollectionId }; subject_kind: "user"|"agent"|"role"; subject_id: string; access: "read"|"comment"|"edit"|"admin" }
  | { kind: "acl.revoke"; scope: { doc_id: DocId } | { collection_id: CollectionId }; subject_kind: "user"|"agent"|"role"; subject_id: string }
  // Principals --------------------------------------------------------------
  | { kind: "agent.create"; agent_id: AgentId; owner_user_id: UserId | null; name: string }
  | { kind: "agent.rename"; agent_id: AgentId; name: string }
  | { kind: "agent.revoke"; agent_id: AgentId }
  | { kind: "token.create"; token_id: TokenId; bound_to: { agent_id: AgentId } | { user_id: UserId }; scopes: Scope[]; expires_at: number | null }
  | { kind: "token.revoke"; token_id: TokenId }
  // Mirror ------------------------------------------------------------------
  | { kind: "mirror.configure"; patch: Partial<{ remote_url: string; branch: string; auth_kind: string; path_template: string; debounce_ms: number; batch_window_ms: number }> }
  | { kind: "mirror.enable";  }
  | { kind: "mirror.disable"; }
  | { kind: "mirror.reset_state"; mirror_id: MirrorId; workspace_id: WorkspaceId; cleared_state: true; reprojected: boolean; touched_credentials: false }   // F50 + F58
  | { kind: "mirror.reset_auth";  mirror_id: MirrorId; workspace_id: WorkspaceId; revoked_secret_ref: true; disabled: boolean; cleared_state: false }      // F58
  // Custom domain -----------------------------------------------------------
  | { kind: "custom_domain.add";    domain: string }
  | { kind: "custom_domain.verify"; custom_domain_id: CustomDomainId; verification_method: "dns" | "http" }   // F50: richer than old {domain}
  | { kind: "custom_domain.remove"; domain: string }
  // Webhooks (F56) ----------------------------------------------------------
  | { kind: "webhook.created";  webhook_id: string; workspace_id: WorkspaceId; url: string; events: string[]; resolved_ip: string }
  | { kind: "webhook.updated";  webhook_id: string; patch: Partial<{ url: string; events: string[]; active: boolean; resolved_ip: string; resolution_policy: "manual" | "auto_on_failure" }> }
  | { kind: "webhook.deleted";  webhook_id: string }
  | { kind: "webhook.rotated";  webhook_id: string; new_secret_version: number; dual_accept_until: number }
  | { kind: "webhook.circuit_broken"; webhook_id: string; failure_count: number; broken_at: number }
  | { kind: "webhook.test_delivery";  webhook_id: string; delivery_id: string; status: number | null; error: string | null }
  // Admin actions (F50) — replay is a no-op; enumerated for exhaustiveness --
  | { kind: "admin.reembed_workspace"; workspace_id: WorkspaceId; model_from: string; model_to: string }
  | { kind: "admin.reindex_workspace"; workspace_id: WorkspaceId; index_kind: "fts" | "hnsw" }
  | { kind: "admin.evict_doc";     doc_id: DocId }
  | { kind: "admin.unlock_doc";    doc_id: DocId }
  | { kind: "admin.job_requeue";   job_id: string; queue: string }
  | { kind: "admin.job_cancel";    job_id: string; queue: string }
  | { kind: "admin.queue_pause";   queue: string }
  | { kind: "admin.queue_resume";  queue: string }
  | { kind: "admin.secret_rotate"; secret_kind: string; dual_accept_until: number }
  | { kind: "admin.diagnose";      workspace_id: WorkspaceId; bundle_id: string; with_content: boolean };   // §9.7 bundle export
```

**Audit record envelope (F32).** Every persisted `audit_events` row is one of three variants:

```ts
export type AuditRecord =
  | { outcome: "allow"; effect: AuditEffect }
  | { outcome: "deny";  reason: DenyReason; effect: AuditDeny }
  | { outcome: "error"; error: HandlerError; effect: AuditError };

export type AuditDeny  = { kind: "deny";  capability: CapabilityId; required_scopes: Scope[]; reason_code: string };
export type AuditError = { kind: "error"; capability: CapabilityId; error_code: string; retriable: boolean };

// Supporting types used by effectOnDeny / effectOnError (§4.1):
export type DenyReason =
  | { kind: "missing_scope"; required: Scope[]; principal_scopes: Scope[] }
  | { kind: "cross_workspace" }
  | { kind: "human_only" }
  | { kind: "rate_limited"; bucket: string; retry_after_ms: number }
  | { kind: "acl_deny"; scope: { doc_id: DocId } | { collection_id: CollectionId } }
  | { kind: "sub_block_acl_not_implemented" };

export type HandlerError =
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found"; subject_kind: SubjectKind; subject_id: string }
  | { kind: "conflict" }
  | { kind: "resource_limit"; detail: string }
  | { kind: "upstream"; service: string; status: number }
  | { kind: "internal"; trace_id: string };
```

Deny and error rows are emitted in an audit-only DB tx (no `doc_updates` row). The replay reducer for invariant 3a is a no-op for `deny`/`error` kinds; the `audit-effect-exhaustiveness` lint (§16.8) requires a branch for every variant even when the branch is empty.

**Collapse policy** (F2):

```ts
export type CollapsePolicy =
  | { collapsible: false }                         // all mutations
  | { collapsible: true; collapseKey: (input: unknown) => string; window_ms: 1000 };
```

Only `category = "read"` capabilities may set `collapsible: true`. Enforced by:

- A runtime assertion in dispatcher: mutation with `collapsible=true` throws at startup.
- A contract test: every capability where `category === "mutation"` asserts `collapsePolicy.collapsible === false`.

**JobPayload** (typed per queue):

```ts
export type JobPayload =
  | { queue: "projection_blocks"; doc_id: DocId; workspace_id: WorkspaceId; snapshot_seq: number }
  | { queue: "embed";             block_id: BlockId; workspace_id: WorkspaceId; model_version: number }
  | { queue: "search_reindex";    doc_id: DocId; workspace_id: WorkspaceId }
  | { queue: "mirror.project_doc"; doc_id: DocId; workspace_id: WorkspaceId; snapshot_seq: number }
  | { queue: "mirror.push";       workspace_id: WorkspaceId }
  | { queue: "mirror.reconcile";  workspace_id: WorkspaceId | null }      // null = all
  | { queue: "reaper";            batch: "doc_updates_tombstones" | "soft_delete_windows" | "attachments" | "orphan_uploads" | "reconcile_bases" }
  | { queue: "compaction";        doc_id: DocId; workspace_id: WorkspaceId }
  | { queue: "webhook";           webhook_id: string; event: string; payload: unknown }
  | { queue: "email";             to: string; template: string; data: unknown }
  | { queue: "dcr_cleanup" }
  | { queue: "restore_search";    doc_id: DocId; workspace_id: WorkspaceId }
  | { queue: "purge";             kind: "doc" | "workspace"; id: string; workspace_id: WorkspaceId }
  | { queue: "outbox_forwarder" };
```

The `kind` discriminants mean a fuzzer exhaustively generates every effect + payload shape, and the audit-replay reducer (invariant 3a) has one branch per `AuditEffect` kind — enforced by the `audit-effect-exhaustiveness` lint rule (§16.8).

### 16.4 `CapabilityContext` — the primitive every handler consumes

```ts
export interface CapabilityContext {
  readonly principal: Principal;                 // already authenticated
  readonly tenant: { workspace_id: WorkspaceId };// already resolved
  readonly db: TenantScopedDb;                   // scoped; un-scoped query is a compile error
  readonly transact: <T>(
    doc_id: DocId,
    fn: (editor: BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>) => T | Promise<T>
  ) => Promise<T>;                               // the only path to Y.Doc mutation; see §6
                                                 // F55: editor is BlockNoteEditor (exposes
                                                 // insertBlocks/updateBlock/removeBlocks);
                                                 // ServerBlockNoteEditor is a conversion
                                                 // surface without those methods (ADR 0018).
  readonly outbox: (
    event: string,
    payload: unknown
  ) => void;                                     // records an event in the write-path tx
                                                 // forwarder enqueues downstream jobs
  readonly logger: Logger;                       // pino w/ trace_id
  readonly tracer: Tracer;                       // OTel; use span() to nest
  readonly now: () => number;                    // injectable clock for tests
}
```

**What is explicitly absent:**

- **No `audit` writer.** Handlers do not write audit rows. The dispatcher writes them in the outer tx using `capability.audit.effectOnAllow(input, postState)` for accepted mutations, and `effectOnDeny` / `effectOnError` for denied / errored invocations (F3 + F32 fix — §6.2, §9.3). A handler that tried to write an audit row would have no way to do so.
- **No `jobs` enqueuer.** Handlers don't enqueue jobs directly. They emit events through `ctx.outbox(...)` so the row lands in the same tx as the `doc_updates` + `audit_events` write; a background forwarder will then read the outbox and call `JobService.enqueue` (transactional outbox pattern, F10 — §6.3). **Status as of 2026-04-21:** `ctx.outbox(...)` is wired transactionally at the trunk composition root — `packages/api-server/src/composition/createApiDispatcher.ts` (the non-test dispatcher composition) queues handler-emitted events during `fn(extras, auditTx)` and flushes them through `createOutboxWriter().append(auditTx, …)` before `withSystemTx` commits, inside the same `BEGIN IMMEDIATE` region as the capability's `ctx.db` writes, the `doc_updates` rows (content mutations only), and the dispatcher-written audit row. `doc.publish` and `doc.unpublish` are the first capabilities to exercise this seam: both emit `doc.visibility_changed` (§5.4, F5) with the post-update `visibility_version` as the invalidation key. Coverage pins this at two layers: `createApiDispatcher.integration.test.ts` nails the one-case allow / throw shapes, and the N-way fault-injection property test `packages/api-server/prop/metadata-only-atomicity.test.ts` (§17.1 row 7b) fuzzes atomicity across every in-tx query ordinal against the real factory (via a plugin-wrapped driver, not a mirrored fixture). The dispatcher-package's own unit/integration/property test fixtures under `packages/dispatcher/{src,prop}/` deliberately retain `ctx.outbox(...)` as a no-op stub — those tests verify dispatcher semantics in isolation, not trunk composition. The read-path `ctx.outbox` at `createApiDispatcher` throws a descriptive error (reads must not emit — capability bug surfaces loud). The dispatcher-emitted `outbox("doc.updated")` and `outbox("audit.appended")` rows continue to land in the same tx today (F31, verified by `packages/dispatcher/prop/writepath-atomicity.test.ts`).
- **No raw Kysely, no raw Hocuspocus, no `globalThis`, no `process.env`.** Config comes through the dispatcher-assembled context. Better Auth primitives are wrapped by `packages/auth-service` (§16.1 / F28). No direct HTTP request/response object reaches the handler.

Every handler signature is:

```ts
async function handler(ctx: CapabilityContext, input: I): Promise<O>
```

No `req`, no `res`, no `userId` positional arg, no `db` positional arg. The handler cannot cheat.

`ctx.transact` may be called **at most once per handler invocation**. This is asserted at runtime by the dispatcher; the planned `transact-called-at-most-once` rule in `@editorzero/arch-lint` will add a static backstop once the package ships (F89 — arch-lint is not yet implemented). Handlers that mutate across multiple docs must do so at the service layer across multiple capability invocations (typically via a job) — cross-doc atomicity is not a CRDT primitive.

### 16.5 `BlockTypeSpec` — the primitive every block type declares (ADR 0013)

`BlockTypeSpec` is the fidelity-tier descriptor editorzero carries per block type. **Do not confuse with BlockNote's own `BlockSpec` type (`{ config, implementation, extensions }` from `@blocknote/core`)** — different concern, colliding name; we renamed ours to avoid the collision at import sites.

```ts
import type {
  Block, BlockSchema, DefaultBlockSchema,
  DefaultInlineContentSchema, DefaultStyleSchema,
  InlineContentSchema, StyleSchema,
} from "@blocknote/core";
import type { RootContent } from "mdast";

export type MdastBlockNode = RootContent;

export interface BlockTypeSpec<
  Attrs extends Record<string, unknown>,
  BSchema extends BlockSchema = DefaultBlockSchema,
  ISchema extends InlineContentSchema = DefaultInlineContentSchema,
  SSchema extends StyleSchema = DefaultStyleSchema,
> {
  readonly type: string;                          // "editorzero:core/heading"
  readonly tier: FidelityTier;                    // lossless | directive | opaque
  readonly attributes: z.ZodType<Attrs>;
  readonly toMarkdown: (block: Block<BSchema, ISchema, SSchema>) => string;
  readonly fromMarkdown: (md: MdastBlockNode) => Block<BSchema, ISchema, SSchema> | null;
  readonly equivalence?: (
    a: Block<BSchema, ISchema, SSchema>,
    b: Block<BSchema, ISchema, SSchema>,
  ) => boolean;
  // reactView lives in `@editorzero/blocks/react` (requires @blocknote/react);
  // kept out of the kernel so the main export stays dep-light.
}
```

The property-test harness fuzzes every `BlockTypeSpec` against its declared tier contract. Registering a new block type auto-creates the fidelity test row.

### 16.6 Semantic naming

- **File path ↔ capability id.** `capabilities/src/<group>/<name>.ts` implements `"<group>.<name>"`. A tsmorph check at build asserts the mapping.
- **Repo per aggregate.** `db/repos/docs.ts` exports `docRepo`; `docs/foo.service.ts` imports `docRepo`. One aggregate per file.
- **Service functions read like the thing they do.** `publishDoc`, not `handleDocPublish`; `reconcileBlocks`, not `util1`.
- **Tests co-located with unit, separated by kind at package level.**
  - `foo.unit.test.ts` next to `foo.ts`.
  - `foo.integration.test.ts` under `packages/<pkg>/test/integration/`.
  - `foo.prop.test.ts` under `packages/<pkg>/test/prop/`.
  - Contract and E2E tests live in their own packages (`contract-tests`, `e2e`).

An agent can guess the path for any file type given the thing they want. No surprise routing.

### 16.7 Codegen inventory

| Artifact | Source of truth | Generator | Location | When | Committed? |
|---|---|---|---|---|---|
| Kysely DB types | Atlas `schema/*.sql` | `kysely-codegen` | `packages/db/src/generated/` | `pnpm codegen` | yes |
| Capability registry barrel | `capabilities/src/**/*.ts` | small bun script | `packages/capabilities/src/registry.ts` | build + watch | yes |
| OpenAPI spec | Capability zod schemas | `@hono/zod-openapi` at runtime; snapshot via `pnpm openapi:snapshot` | `packages/api-server/openapi.snapshot.json` | CI on change | yes (snapshot); runtime otherwise |
| MCP tool list | Capability registry | `packages/mcp-server/src/create-mcp-handler.ts` (registry → tool loop at handler-factory time) | runtime | runtime | n/a |
| CLI command tree | Capability registry | `apps/cli/src/registry.ts` + `apps/cli/src/generator/` | runtime + frozen in `bun build --compile` | build | n/a (baked into binary) |
| Contract-test matrix | Capability registry | `packages/contract-tests/src/generate.ts` | `packages/contract-tests/generated/` | `pnpm test:contract` | yes |
| BlockNote schema | BlockSpecs registry | barrel | `packages/blocks/src/schema.ts` | build | yes |

Rule: **if it's derived, it's generated; if it's generated, it's committed (when feasible) or snapshot-compared**. Drift is a CI failure.

### 16.7a Runtime dependency pins (F24 fix)

Pins live in `package.json` + a `packages/pins/pins.json` registry used by CI to assert minimum versions and known-vulnerable ranges. The committed table:

| Dependency | Min version | Note | Source |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1` (not 2.x alpha) | Re-pin when 2.x GA | ADR 0009 |
| `better-auth` | `>=1.6.5` | GHSA-xr8f-h2gw-9xh6 fix | ADR 0010 |
| `@better-auth/sso` | latest ≥1.6.5 | SAML SLO + replay protection | ADR 0010 |
| `@better-auth/oauth-provider` | latest ≥1.6.5 | DCR + PKCE S256 | ADR 0010 |
| `@better-auth/mcp` | latest ≥1.6.5 | `withMcpAuth` / `mcpAuthHono` | ADR 0009/0010 |
| `@better-auth/api-key` | latest ≥1.6.5 | `referenceId` + `permissions` | ADR 0016 |
| `@better-auth/agent-auth` | `^1.5.6` **unstable** through 2026-H2 | Wrap behind Principal abstraction | ADR 0016 |
| `@hono/zod-openapi` | latest compatible with zod v4 | Generator for OpenAPI spec | §14 |
| `zod` | `^4` (StandardSchema-compatible) | Single schema across all surfaces | §4 / §16 |
| `hono` | latest LTS | Router under `/api` + `/mcp` | ADR 0002 |
| `@hocuspocus/server` | `3.4.4` (min) | Durability boundary notes apply | ADR 0006 |
| `yjs` | stable v13.x | CRDT core | ADR 0003 |
| `@blocknote/core`, `@blocknote/react` | latest stable | MPL-2.0 | ADR 0004 |
| `@blocknote/server-util` | latest stable | `ServerBlockNoteEditor` | ADR 0018 |
| `@blocknote/xl-*` | **not permitted in v1** | GPL-3.0, constrains commercial options (F25) | ADR 0004 / §19 Q1 |
| `kysely` | `^0.28` | Query builder | ADR 0007 |
| `kysely-codegen` | `^0.20` | Type generation from Atlas schema | ADR 0007 |
| `pg-boss` | latest stable | Postgres job queue | ADR 0014 |
| `pgvector` | `>=0.8.2` | CVE-2026-3172 fix | ADR 0008 |
| `sqlite-vec` | `^0.1.9` | Brute-force primary path | ADR 0008 |
| `remark-parse`, `remark-directive` | pinned (exact) | Markdown determinism; bump requires ADR 0013 harness re-run | ADR 0013 |
| `onnxruntime-node` | latest stable | Embedding runtime | ADR 0008 |
| `simple-git` | latest stable | Git mirror | ADR 0020 |
| `atlas` (CE) | Community build | `migrate lint` CE coverage | ADR 0007 |

CI step `pnpm pins:check` fails the build if `package.json` drops below any min or picks up a banned range.

### 16.8 Architecture lint rules

Target shape: a small set of Biome rules + a custom `@editorzero/arch-lint` package using `ts-morph`. The `arch-lint` package is not yet implemented (F89). The rule roster below is the v1 target; actual enforcement-today column distinguishes what is already gated vs. what is written-but-not-yet-bite.

| Rule | Enforcement today | Target home |
|---|---|---|
| `no-raw-kysely-outside-db` (F4) — `Kysely`, `sql<T>` raw importable only inside `packages/db/**` | **Enforced** by `scripts/coherence.ts` at pre-commit | `@editorzero/arch-lint` (ts-morph) |
| All other rules below | Not yet enforced — review + types + `scripts/coherence.ts`'s other checks are the backstop | `@editorzero/arch-lint` |

Target rule roster (all `@editorzero/arch-lint` except where noted):

- `forbidden-import-direction` — layer → layer matrix (see §16.2).
- `no-deep-import` — cross-package imports must go through `package/index.ts`.
- `capability-id-matches-path` — every `capabilities/<group>/<name>.ts` defines exactly one capability whose `id === "<group>.<name>"`.
- `no-raw-ydoc-access` — `Y.Doc`, `Y.XmlFragment`, etc. are only importable by `packages/sync/**`. Handlers use `ctx.transact`.
- `no-raw-kysely-outside-db` (F4) — `Kysely`, `sql<T>` raw, `db.connection()` importable only inside `packages/db/**`. **Currently enforced by coherence script**; will move to `@editorzero/arch-lint` when that package ships.
- `no-raw-kysely-in-capabilities` — `Kysely` is not importable from `packages/capabilities/**`. Handlers use `ctx.db` (`TenantScopedDb`).
- `ops-db-audit` (F4) — every `OpsDb` construction site requires an `@ops-audited("reason")` decorator and an entry in `ops/ops-db-registry.md`.
- `no-raw-audit-events-query` (F26) — direct Kysely access to `audit_events` is allowed only in `packages/db/repos/audit.ts`.
- `no-process-env` — config flows through a typed config object assembled at boot. Handlers don't read env.
- `audit-effect-exhaustiveness` — every `kind` in `AuditEffect` has a reducer branch in the audit-replay test.
- `json-normalization` — any JSON column has an adjacent `z.ZodType` + canonical-form serializer. Prevents silent schema drift.
- `no-blocknote-xl-in-v1` (F25) — `@blocknote/xl-*` packages are forbidden imports until the commercial-arm question resolves (brief §Open Q1 / ADR 0001).
- `transact-called-at-most-once` (F3) — static analysis of capability handlers: at most one lexical `ctx.transact(...)` call per handler; the dispatcher's runtime at-most-once backstop is what enforces the invariant today.
- `collapse-only-for-reads` (F2) — if `cap.category === "mutation"`, `cap.audit.collapsePolicy.collapsible` must be `false`.

Enforced rules today run at pre-commit and block the commit on violation. The rest are discipline-plus-review until the arch-lint package ships.

### 16.9 Test layout and naming

| Test kind | Where | Naming | Runs | Purpose |
|---|---|---|---|---|
| Unit | co-located | `<name>.unit.test.ts` | pre-commit (affected) | Pure logic, no I/O |
| Integration | `<pkg>/test/integration/` | `<name>.integration.test.ts` | pre-push (SQLite + Postgres matrix) | Real driver; repo layer + up |
| Property | `<pkg>/test/prop/` | `<name>.prop.test.ts` | pre-commit (short) + pre-push (full) + nightly (1M rounds for ADR 0013) | Invariants — CRDT convergence, fidelity, inverse-restore, audit replay, permission |
| Contract | `packages/contract-tests/` | generated, one per `(capability, surface)` | pre-push | Surface parity matrix |
| E2E | `packages/e2e/` | `<flow>.e2e.ts` | pre-push (fast), smoke-deploy (full) | Real browser + `@axe-core/playwright` WCAG 2.1 AA |
| Smoke | `ops/scripts/smoke.sh` | n/a | pre-push | `docker compose up`; hit `/health`, create a doc, teardown |
| Eval (search) | `packages/search/test/eval/` | `nDCG.eval.ts` | pre-push (10k corpus) + daily prod | nDCG@10 regression gate (ADR 0008) |

Shared fixtures: `packages/test-fixtures/` exports factory functions returning branded domain objects. No ad-hoc `{id: "test"}` anywhere.

**Golden test pattern:**

```ts
// packages/capabilities/src/doc/update.unit.test.ts
import { withCap } from "@editorzero/test-fixtures";
import { docUpdate } from "./update";

describe("doc.update", () => {
  it("applies block ops atomically", withCap(docUpdate, async ({ invoke, audit }) => {
    const out = await invoke({ doc_id, ops: [/*…*/] });
    expect(out).toMatchObject({ /*…*/ });
    expect(audit.last()).toMatchObject({
      capability_id: "doc.update",
      outcome: "allow",
      effect: { kind: "block.update", /*…*/ },
    });
  }));
});
```

`withCap` wires the dispatcher + a memory DB + a Hocuspocus stub + an in-memory audit writer. Every capability gets this for free.

### 16.10 Error primitives

```ts
export abstract class EditorZeroError extends Error {
  abstract readonly code: string;       // stable; surfaces map this
  abstract readonly httpStatus: number; // surface-agnostic; adapter uses it
  readonly fields?: Record<string, unknown>;  // structured context
}
export class PermissionDeniedError extends EditorZeroError { /* … */ }
export class ValidationError       extends EditorZeroError { /* … */ }
export class NotFoundError         extends EditorZeroError { /* … */ }
export class RateLimitError        extends EditorZeroError { /* … */ }
export class ConflictError         extends EditorZeroError { /* … */ }
export class ResourceLimitError    extends EditorZeroError { /* … */ }
export class UpstreamError         extends EditorZeroError { /* … */ }
export class InternalError         extends EditorZeroError { /* … */ }
```

Handlers throw typed errors. Each surface adapter has a single `mapError(err, surface)` pass that converts to HTTP status + RFC 9457 problem body (API), CLI exit code + stderr message, MCP protocol error, or UI `ActionResult`. Adapters never invent errors; they only map.

### 16.11 Observability primitives

- **Spans at layer boundaries**, not per function. Dispatcher emits one span per capability invocation; repo layer wraps queries in spans; mirror jobs, Hocuspocus handlers, MCP sessions all emit a canonical span.
- **Typed log events.** `logger.info({ event: "doc.published", doc_id, principal_id })` — `event` is a string-literal union (`LogEvent`) so grep/Loki queries resolve cleanly.
- **Span attributes are typed** via a helper (`attr.principal(p)` returns `{ "principal.kind": ..., "principal.id": ..., "principal.token_id": ... }`) — no string-key sprawl.
- **Every span carries `workspace_id`.** Per-tenant filtering is one query.

### 16.12 Secret management (F35)

All secrets flow through a typed config layer; `process.env` is never read directly by product code.

**Typed config.** `packages/config/secrets.ts` exports a discriminated union of secret sources:

```ts
export type SecretRef =
  | { mount: "file";  path: string }
  | { mount: "env";   env_var: string }
  | { mount: "vault"; vault_path: string };

export interface Secrets {
  BETTER_AUTH_SECRETS: SecretRef;
  S3_CREDENTIALS: SecretRef;
  SMTP_CREDENTIALS: SecretRef;
  OTLP_EXPORTER_AUTH: SecretRef;
  WEBHOOK_SIGNING_KEY: (workspace_id: WorkspaceId) => SecretRef;
  MIRROR_AUTH: (workspace_id: WorkspaceId, mirror_id: MirrorId) => SecretRef;
  KMS_MASTER_KEY: SecretRef;
}
```

Secrets split into two classes by rotation policy (F79):

- **Startup-only secrets** — DB connection strings, S3 endpoint, OTLP endpoint. Construction at boot reads the `SecretRef` once and caches the resolved value behind an interface; **rotation requires restart**. Handlers receive these via a `StartupSecretProvider` on dispatcher context.
- **Runtime-rotatable secrets** — `BETTER_AUTH_SECRETS`, per-workspace webhook signing keys, per-workspace mirror auth tokens, agent-token signing keys. These live behind a **versioned cache** keyed by `secret_version`. `admin.secret_rotate` publishes `secret_rotated:{secret_kind}:{new_version}` on Redis pub/sub (HA) or the in-process `EventBus` (single-node); each node invalidates its cached value and re-resolves on next use. The dual-accept window honors version `N-1` until retire time (see rotation sequence below). Handlers receive these via a `RotatableSecretProvider` on dispatcher context.

The split means a rotation of a webhook signing key takes effect in seconds across all nodes without restart; a DB-endpoint change still requires an operator-driven restart.

**At rest.** Secrets are encrypted with a **per-instance master key**. Master key sourced from:

- Single-node: OS secret store (libsecret / macOS Keychain / Windows Credential Manager).
- HA: operator-configured KMS hook via `KMS_URL` (AWS KMS / GCP KMS / HashiCorp Vault transit).

**`admin.secret_rotate` capability** (Appendix A) rotates:

- `BETTER_AUTH_SECRETS` (per ADR 0010 90-day schedule).
- Per-workspace webhook signing keys.
- Per-workspace mirror auth tokens.
- Agent-token signing keys.
- Diagnostic salts (per-workspace; F64).

Rotation sequence: (1) create new key with version `N+1`; (2) **dual-accept window** — both old (version `N`) and new (version `N+1`) keys valid for the full rotation window; publish `secret_rotated:{secret_kind}:{N+1}` on Redis pub/sub (HA) / in-process EventBus (single-node); each node invalidates its cached value and re-resolves; (3) retire old at end of window. Sessions signed under the old key are invalidated at the end of the dual-accept window via the revocation cascade (§10.3) — not abruptly on rotation start.

**Concurrency control (F79 + F60).** A second rotation on the same `secret_kind` while the previous dual-accept window is still open corrupts invariants (which version is "N-1"?). Rotation is serialized:

- **Postgres mode:** pg-boss `singletonKey = "secret_rotate:" + secret_kind + ":" + workspace_id` — duplicate rotations collapse.
- **SQLite mode:** DB advisory lock on the same key.
- Concurrent rotation requests that race the singleton → `ConflictError` with `retry_after_ms = dual-accept window remaining`.

Property test `concurrent-rotation.prop.ts` is listed explicitly in §17.1 invariant mapping (F60).

**Webhook HMAC signing.** Delivery headers:

- `X-EditorZero-Signature: v1=<hex(HMAC-SHA256(secret, "<timestamp>.<body>"))>`
- `X-EditorZero-Timestamp: <unix_ms>`
- Replay window: receivers reject timestamps > 5 min skew.
- **Canonical body (F62):** HMAC is computed over the **raw UTF-8 bytes of the HTTP POST body** before any JSON parse / transform. Verify-before-parse.

**Mirror auth.** Per-workspace token stored under `mirror_configs.auth_ref → secret_store://mirror/{workspace_id}/{mirror_id}`. Split operations (F58):
- `mirror.reset_state` — clears `mirror_state`, enqueues full re-projection; does NOT touch `auth_ref`.
- `mirror.reset_auth` — revokes the `auth_ref` secret and disables the mirror; does NOT clear `mirror_state`. Re-enabling requires a fresh `mirror.configure`.

Replay is unambiguous because each audit variant carries the boolean `cleared_state` / `touched_credentials` / `disabled` / `revoked_secret_ref` fields (§16.3).

**Gotcha surfaced to AGENTS.md:** "Never read secrets via `process.env` directly; always go through `packages/config/secrets.ts`." Enforced by the `no-process-env` lint rule (§16.8).

Property tests:

- `secret-rotation.prop.ts`: rotation invalidates old-key signatures at the end of the dual-accept window; both keys accepted during the window.
- `webhook-signature.prop.ts`: webhook signature verification rejects mangled bodies and timestamps outside the 5-min window.

### 16.13 Dev loop

```
pnpm dev              # apps/app + apps/admin on :3000/:3001, Hocuspocus embedded
pnpm test             # unit (affected), fast property, lint, types
pnpm test:full        # + integration (SQLite + Postgres), contract, property full, E2E, smoke
pnpm codegen          # Kysely types from Atlas, registry barrel, OpenAPI snapshot
pnpm migrate          # atlas migrate apply against local dev DB
pnpm format / lint    # Biome
pnpm openapi:snapshot # regenerate snapshot; CI compares
```

- **Pre-commit (fast, < 20s):** types, lint, format, unit-affected, fast-property-affected, schema drift.
- **Pre-push (complete, < 5min):** full pre-commit + integration + contract + E2E + smoke deploy + observability check.
- **Nightly (on a schedule if we ever add one):** 1M-round property fuzz (ADR 0013); longer eval corpus.
- **Affected-only** via `turbo run --filter` or `pnpm -r --filter "[HEAD^1]"`.

A pre-commit hook that's slow enough to cause friction is split, per AGENTS.md.

### 16.14 Capability versioning

- Adding a capability: non-breaking. Once the surface generators and contract-test matrix land, contract tests add a row and pre-commit fails until every type-compatible surface is generated.
- Changing a capability's **input** schema in a backward-incompatible way: ship `doc.update_v2`; mark old `deprecated: { since, sunset, replacement: "doc.update_v2" }`. Once the contract matrix lands, deprecated capabilities still pass contract tests until sunset; old MCP tools / OpenAPI routes / CLI subcommands emit a warning.
- Removing a capability: only after sunset. Once the contract matrix lands, contract tests confirm removal; migration notes in CHANGELOG.md.
- Renaming: forbidden. Add the new, deprecate the old. (Renames silently break clients.)

### 16.15 Working rules for a coding agent in this repo

These complement AGENTS.md's working rules:

1. **Start at the capability.** Every change begins at a capability in `packages/capabilities`. If no capability captures the intent, add one (with ADR if structural).
2. **Follow layer imports.** If the code you're writing wants to import across the arrow direction, the design is wrong. Refactor the layering or move the call.
3. **Derive, don't duplicate.** If you're about to hand-author a schema, check: does the registry already have it? Can you generate instead?
4. **Use `ctx.transact`.** Never `import { Hocuspocus }` in a capability handler. If the test for a doc mutation doesn't show a `transact` call, the code is wrong.
5. **Test at the smallest scope that proves the guarantee.** Pure logic → unit. Invariant → property. Cross-driver behavior → integration. Cross-surface parity → contract. User flow → E2E.
6. **Trust types.** If something's typed, don't add a runtime guard. If it can be typed but isn't, type it.
7. **No tactical comments.** Per CLAUDE.md global rules. A comment should explain a WHY that a reader of the current code can't see. "Used by X" belongs in the commit, not the file.
8. **Commit boundaries mirror capabilities.** One capability's addition or change per commit where possible. Contract tests land in the same commit.
9. **Pre-commit failure = design signal.** If a lint rule is in your way, fix the design, not the rule. Only amend rules via ADR-level discussion.
10. **When in doubt, write the property test first.** If you can state the guarantee, you can encode it. The test you write first is the test that doesn't regress silently later.

These rules are what keep four surfaces and a CRDT backbone from drifting as capabilities grow.

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

## 18. Deployment topology

Per ADR 0012:

- **Single-node default:** `docker compose up`. One app container (Node 22 + Hono + Next + Hocuspocus + MCP + jobs), one Caddy sidecar, one SQLite volume. Installer URL serves `install.sh` pattern.
- **HA:** multi app replicas behind Caddy, Postgres, Redis, optional S3/MinIO for attachments + mirror archive. pg-boss per Postgres. Hocuspocus worker-nodes + single-manager.
- **CLI:** Bun-compiled static binaries, 5 target tuples (linux amd64/arm64, darwin amd64/arm64, windows amd64).
- **Backups (F84):**
  - **Postgres mode:** **continuous WAL archiving to S3 (primary)** — this is the RPO-bearing backup. Nightly `pg_dump` is a **secondary consistency backup** for operator-driven export (human-readable, single-file, convenient for `editorzero diagnose` / off-prem storage). `pg_dump` is NOT the DR primary.
  - **SQLite mode:** nightly `VACUUM INTO` + object-store copy.
  - Object store: snapshot of attachments bucket + Caddy cert storage (F59).
  - `doc_snapshots + doc_updates` implied by DB backup; `reconcile_bases` same (§3.18).

### 18.1 Disaster recovery (F34)

- **RPO (Recovery Point Objective):**
  - **Postgres mode:** 15 min via continuous WAL archiving to object storage (S3 / MinIO / compatible).
  - **SQLite mode:** 24 h via nightly `VACUUM INTO`.
- **RTO (Recovery Time Objective):**
  - 30 min to service on single-node restore.
  - 2 h for multi-node HA rebuild (Postgres PITR + node provisioning + cert reissue).
- **Restore procedure:**
  - **Postgres:** PITR to target timestamp, object-store restore to the same timestamp (attachments), Redis rebuild from empty (session registry + `custom_domains` cache + awareness state repopulate on first reconnect), Caddy certs restored from backup (see cert storage below).
  - **SQLite:** restore `*.sqlite` + `*-wal` files from backup; object-store restore to the same timestamp; Caddy certs restored from backup.
- **Caddy cert storage must be backed up (F59).** Back up and restore the **Caddy data directory** (single-node) or the Postgres cert-storage table (HA) alongside the DB + object store. Without this, restoring a workspace with N custom domains triggers N ACME re-issuances simultaneously — Let's Encrypt's **7-day renewal window** and per-tenant **5/day issuance cap** (ADR 0011) make this a real outage risk on workspaces with more than a handful of domains.
- **DR-mode cert cap bypass (F59).** An operator-bypassable flag `EDITORZERO_DR_MODE=true` can be set during restore. While active (24h): the ACME rate cap is raised; every cert re-issuance logs loudly at `warn` level with `reason="dr_mode"`; flag auto-clears after 24h. Cross-reference ADR 0011.
- **Backup coordination constraint (F84).** Database + object store **must be snapshotted within a 1-minute window** to avoid dangling `attachment_refs`. The coordination window is defined against the **WAL-archive snapshot point** (Postgres) or the `VACUUM INTO` completion point (SQLite), **not** the `pg_dump` completion point — `pg_dump` is the secondary consistency backup, not the primary. Backup script: `scripts/backup.sh` (to be created in Phase 3) executes `pg_basebackup` or WAL-archive reference + `VACUUM INTO` and object-store snapshot inside the window and verifies within a tolerance. Cross-reference ADR 0007.
- **Ephemera policy.** Redis holds session registry (F7 / §10.3), `custom_domain` proxy cache (§5.4), workspace awareness state. All rebuildable from Postgres within seconds of first reconnect; Redis loss does not require a restore.
- **`doc_updates` tombstone reaper floor.** The reaper (ADR 0007 compaction) must **not reap tombstoned rows older than `max(RPO, 24h)` minus the pin**. Pin at **72h** for safety — ensures a 15-min-RPO restore can still replay post-snapshot updates without gap.
- **Restore CLI.** Appendix A carries `editorzero restore --from=<backup>`; implementation is Phase 4 work.

## 19. Open questions (carried into Phase 3)

Phase 1 resolved 2 of 4 open questions. Two remain; neither blocks Phase 3.

1. **Commercial arm** (brief §Open). Default proposal: **OSS-only in v1.** AGPL-3.0 + DCO (ADR 0001) keeps the door open for a hosted tier later without a license change. Revisit after Phase 5 launch data (install rate, GitHub stars, pull).
2. **Agent offline-edit**. Default proposal: **always-online in v1.** MCP Streamable HTTP reconnect semantics (§15.4) cover transient disconnects; a true offline mode (agent edits locally, reconciles on re-sync) requires a replica Y.Doc on the agent side — not impossible given Yjs, but non-trivial product scope. Revisit if a real user shows up for it.

Both will appear in the Phase 3 continuation as "pending, no change."

---

## Appendix A — Capability matrix

Legend:
- **H** = callable by human (session / PAT). **A** = callable by agent (API key / agent-auth / MCP). **—** = unavailable.
- **Surfaces**: **API** / **CLI** / **MCP** / **UI** (Web UI SPA via typed RPC).

This matrix incorporates red-team fixes F12, F13, F15, F19, F22.

| Capability | Requires (scopes) | H | A | API | CLI | MCP | UI | Rate (per-min) | Audit effect kind |
|---|---|---|---|---|---|---|---|---|---|
| `capabilities.list` | — (filtered by principal — F22) | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `capabilities.describe` | — (filtered by principal — F22) | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `workspace.create` | admin (`humanOnly` in MVP; creating a whole workspace from within another workspace is a later capability) | H | — | ✓ | ✓ | — | ✓ | 10 | `workspace.create` |
| `workspace.update` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `workspace.update` |
| `workspace.get` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `workspace.list` | — | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `workspace.delete` | workspace:admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 5 | `workspace.soft_delete` |
| `workspace.restore` | workspace:admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 5 | `workspace.restore` |
| `workspace.purge` | workspace:admin + admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `workspace.purge` |
| `workspace.member_add` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `member.add` |
| `workspace.member_list` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `workspace.member_remove` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `member.remove` |
| `workspace.member_update_role` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `member.update_role` |
| `collection.create` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `collection.create` |
| `collection.update` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `collection.update` |
| `collection.move` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `collection.move` |
| `collection.delete` | doc:delete | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `collection.soft_delete` |
| `collection.restore` | doc:delete | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `collection.restore` |
| `collection.list` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `doc.create` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 300 | `doc.create` |
| `doc.get` | doc:read | H | A | ✓ | ✓ | ✓ (resource) | ✓ | 600 | read |
| `doc.list` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `doc.update` (F12: **canonical batch mutation**; replaces separate `block.insert/update/remove`. [ADR 0022](adr/0022-agent-editing-constraints.md): per-op `expect_prior_content_hash?` on `update`/`move`/`remove`/`set_visibility` ops; `precondition_policy?: "strict"` reserved.) | doc:write, block:write | H | A | ✓ | ✓ | ✓ | ✓ | 600 (bucket `doc.write`) | `doc.update_batch` |
| `doc.update_from_markdown` (F66/F73: takes opaque `reconcile_base_token` from `doc.get`/`doc.get_markdown`) | doc:write, block:write | H | A | ✓ | ✓ | ✓ | — | 300 (bucket `doc.write`) | `doc.update_batch` (post-reconcile) |
| `doc.rename` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.rename` |
| `doc.move` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.move` |
| `doc.delete` | doc:delete | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.soft_delete` |
| `doc.restore` | doc:delete | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.restore` |
| `doc.purge` | doc:delete + admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 5 | `doc.purge` (full preimage) |
| `doc.publish` | doc:publish | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.publish` |
| `doc.unpublish` | doc:publish | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `doc.unpublish` |
| `block.set_visibility` (kept distinct — metadata toggle, not CRDT op) | block:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 (bucket `doc.write`) | `block.set_visibility` |
| `version.create` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `version.create` |
| `version.list` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `version.get` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `version.restore` (F15: serialized per doc; emits pre-restore `version.create` of current state; broadcasts reload) | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `version.restore` (carries pre/post snapshot_seq) |
| `comment.create` | comment:write | H | A | ✓ | ✓ | ✓ | ✓ | 300 | `comment.create` |
| `comment.update` | comment:write | H | A | ✓ | ✓ | ✓ | ✓ | 300 | `comment.update` |
| `comment.resolve` | comment:resolve | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `comment.resolve` |
| `comment.delete` | comment:write | H | A | ✓ | ✓ | ✓ | ✓ | 120 | `comment.soft_delete` |
| `comment.list` | comment:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `attachment.request_upload` (F57/F80: creates pending upload, returns signed PUT URL) | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `attachment.request_upload` |
| `attachment.confirm_upload` (F57/F80: verifies + moves blob + inserts row) | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `attachment.confirm_upload` |
| `attachment.get` | doc:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `attachment.delete` | doc:write | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `attachment.soft_delete` |
| `search.query` (F13: raised from 120) | search:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 (bucket `search.read`) | read (collapsible) |
| `search.suggest` (new — instant/typeahead, narrower scope) | search:read | H | A | ✓ | ✓ | ✓ | ✓ | 1800 (bucket `search.suggest`) | read (collapsible) |
| `permission.grant` | permission:grant | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `acl.grant` |
| `permission.revoke` | permission:revoke | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `acl.revoke` |
| `permission.list` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `audit.list` (paginated via composite `(before_created_at, before_id)` cursor; filters on subject pair, capability_id, outcome, time range) | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read (collapsible) |
| `audit.get` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read (collapsible) |
| `agent.create` | agent:create | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `agent.create` |
| `agent.rename` | agent:create | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `agent.rename` |
| `agent.revoke` | agent:revoke | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `agent.revoke` |
| `agent.list` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `token.create` (agent-tokens: agent:create; user PAT: `humanOnly`) | agent:create OR humanOnly | H | A (agent tokens only) | ✓ | ✓ | ✓ | ✓ | 10 | `token.create` |
| `token.revoke` (agent tokens: agent:revoke; own user PAT: `humanOnly`) | agent:revoke OR humanOnly-self | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `token.revoke` |
| `token.list` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `mirror.configure` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `mirror.configure` |
| `mirror.enable` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `mirror.enable` |
| `mirror.disable` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `mirror.disable` |
| `mirror.push_now` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | read (enqueues job) |
| `mirror.reset_state` (F58: clears `mirror_state` + enqueues full re-projection; no credential touch) | workspace:admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `mirror.reset_state` |
| `mirror.reset_auth` (F58: revokes the secret ref + disables the mirror; requires re-configure to re-enable) | workspace:admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `mirror.reset_auth` |
| `custom_domain.add` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `custom_domain.add` |
| `custom_domain.verify` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `custom_domain.verify` |
| `custom_domain.remove` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `custom_domain.remove` |
| **Webhooks** (F56) |  |  |  |  |  |  |  |  |  |
| `webhook.create` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `webhook.created` |
| `webhook.update` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 60 | `webhook.updated` |
| `webhook.list` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `webhook.get` | workspace:read | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `webhook.delete` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 30 | `webhook.deleted` |
| `webhook.test_delivery` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `webhook.test_delivery` |
| `webhook.rotate_secret` | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `webhook.rotated` |
| `webhook.refresh_dns` (F83: recomputes `resolved_ip` + `resolved_at`) | workspace:admin | H | A | ✓ | ✓ | ✓ | ✓ | 10 | `webhook.updated` |
| `admin.health` | admin (scoped pub subset is available to agents under `agentAllowed`) | H | A (public subset) | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `admin.metrics` | admin | H | A (read-only) | ✓ | ✓ | ✓ | ✓ | 120 | read |
| `admin.diagnose` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 10 | `admin.diagnose` (bundle id) |
| `admin.purge_runner` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | read (triggers cascade jobs) |
| **Admin jobs** (F19) |  |  |  |  |  |  |  |  |  |
| `admin.job_list` | admin | H | A (read-only) | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `admin.job_get` | admin | H | A | ✓ | ✓ | ✓ | ✓ | 600 | read |
| `admin.job_requeue` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 60 | `admin.job_requeue` |
| `admin.job_cancel` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 60 | `admin.job_cancel` |
| `admin.queue_pause` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 10 | `admin.queue_pause` |
| `admin.queue_resume` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 10 | `admin.queue_resume` |
| **Admin search** (F19) |  |  |  |  |  |  |  |  |  |
| `admin.reindex_workspace` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `admin.reindex_workspace` |
| `admin.reembed_workspace` (F30) | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `admin.reembed_workspace` |
| **Admin sync** (F19) |  |  |  |  |  |  |  |  |  |
| `admin.evict_doc` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 30 | `admin.evict_doc` |
| `admin.unlock_doc` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 10 | `admin.unlock_doc` |
| **Admin secrets** (F19) |  |  |  |  |  |  |  |  |  |
| `admin.secret_rotate` | admin (`humanOnly`) | H | — | ✓ | ✓ | — | ✓ | 1 | `admin.secret_rotate` (key_kind, not value) |

**Notes / gaps this matrix makes visible:**

- **F12 applied.** `block.insert`, `block.update`, `block.remove` are **removed as standalone capabilities**. Their intent is expressed as ops inside `doc.update`'s input. This collapses one rate-limit bucket (can't evade a 600/min `doc.write` budget by splitting to N `block.insert` calls), one audit model (`doc.update_batch` captures the full op list), and one mental model (agents batch or not, but don't pick between two APIs).
- **`block.set_visibility` remains distinct** — it's metadata, not a CRDT op; its handler writes `blocks.visibility` + increments `docs.visibility_version` (F5) synchronously inside the dispatcher tx without calling `ctx.transact`.
- **F13 applied.** `search.query` bucket raised to 600/min. `search.suggest` is a new lower-latency capability for typeahead with a generous 1800/min (30/s) budget on its own bucket. Both are read + collapsible (F2 rule: only reads may collapse).
- **`doc.update_from_markdown`** remains API/CLI/MCP only (not UI) — the web editor uses block ops directly. Kept for four-surface parity: agents often prefer Markdown.
- **`humanOnly`** rows (`workspace.delete`, `workspace.purge`, `workspace.create`, `doc.purge`, `admin.*` destructive, `mirror.reset_state`, `mirror.reset_auth`) filter out of MCP `tools/list` (F22); an agent never sees them. They remain on API + CLI for ops tooling.
- **`agentAllowed.extraScopes`** — a few rows grant agents access but with a higher bar (e.g., `admin.health`'s agent-readable subset requires `workspace:read` + `admin` scope tag; most operators never grant `admin` to an agent).
- **Capability IDs** double as registry-barrel keys and file paths (`capabilities/<group>/<name>.ts` → `<group>.<name>`). Adding a row here is adding a file — tools in the scaffolding generator (§Appendix C) do both in one command.

Every row has a corresponding kind in the `AuditEffect` union (§16.3) or is a `read` (no effect row). Exhaustiveness-checked at build.

---

## Appendix B — Subsystem responsibility map

| Subsystem | Owns | Doesn't own |
|---|---|---|
| **Better Auth** | Credential lifecycle, OIDC/SAML/OAuth 2.1/DCR/PKCE, session storage, API keys, Agent Auth Protocol | Principal abstraction, per-tenant audience (we plumb), Hocuspocus session revocation, audit event model |
| **Hocuspocus** | WebSocket sync, `onChange` durability hook, `onStoreDocument` snapshot trigger, Redis fan-out | Auth (calls our middleware), capability dispatch, permissions |
| **BlockNote + Yjs** | Doc model, convergent editing, block IDs, ProseMirror integration | Persistence, permissions, audit |
| **Capability registry** | The shape of the capability set; single source of truth for the eventual surface adapters | Handler implementation (modules own those), auth |
| **Dispatcher** | Resolving principal, evaluating permissions, enforcing rate limits, writing audit | Holding state, executing business logic |
| **TenantScopedDb (Kysely)** | Unbypassable workspace predicate, type-time tenant safety | Table schema (Atlas owns migrations) |
| **Kysely + Atlas CE** | Query building, migrations, Postgres/SQLite dialect split | Relational modeling for Better Auth (adapter-owned) |
| **Job queue** | Durability, retry, backoff for async work | Handler logic |
| **Caddy sidecar** | TLS (on-demand, allow-listed via `ask`), reverse proxy | Auth decisions, routing past reverse-proxy |
| **OTel SDK** | Spans, metrics, logs with trace correlation | SLO policy (operator sets), alerting (Prometheus/external) |

---

## Appendix C — Phase 3 entry checklist

This is a **deliverable specification**, not a status report. Each item describes what Phase 3 must produce before the verification stack is real. **Authoritative status matrix lives in `docs/continuation.md` § Immediate focus → P3.7 (last updated 2026-04-19)** — that table walks every item against the actual tree with one-line evidence pointers. Items 11, 12, and 16 also carry inline status here because each needs a carve-out or scope note spelled out at the source so the gate rule and the matrix count the same way (items 11 + 12 because P3.6 landed evidence directly tied to them; item 16 because it was promoted from an unnumbered carryover). The rest stay in spec form to avoid two-source drift (the matrix is canonical).

Phase 3 must produce:

1. Monorepo scaffold (per ADR 0021 surface-transport topology): `apps/{app,admin,cli}`, `packages/{capabilities,auth,api-server,api-client,db,sync,blocks,search,jobs,mirror,mcp-server,contract-tests,observability,config,webhooks}`. (ADR 0021 moved the CLI from `packages/cli` to `apps/cli` and added `packages/api-server` + `packages/api-client` alongside `packages/mcp-server`.)
2. Two empty capabilities (`workspace.create`, `doc.create`) to be wired into all four surface adapters, exercising the full dispatcher path.
3. Hocuspocus wired in-process with the durability-boundary property test.
4. SQLite + Postgres conformance runners both green on the trivial slice.
5. Pre-commit + pre-push hooks green.
6. `docker compose up` smoke-deploy green.
7. `/metrics` exposes spans for the two capabilities.
8. **SQLite load-ceiling measurement run (F48)** against ADR 0007's declared envelope; results to be committed to `packages/db/test/sqlite-ceiling.report.md`. If the ceiling is not met, ADR 0007 must be revised in the same commit.
9. **Backup script scaffold (F34).** `scripts/backup.sh` to be created covering Postgres PITR + object-store snapshot coordination window and SQLite `VACUUM INTO` + object-store snapshot.
10. **HNSW memory preflight** to be validated at the declared 1M-embedding ceiling (F39 / §11.4) — green on workspaces sized to the declared ceiling; `admin.reembed_workspace` must refuse below the required `maintenance_work_mem`.
11. **ADR 0018 smoke test** (F70): `BlockNoteEditor.create({ collaboration })` inside `openDirectConnection.transact()` under concurrent edits. **Status: PARTIAL — no-WS half closed 2026-04-19.** The no-WS adapter-boundary smoke landed in `packages/sync/src/blocknote.integration.test.ts` (3 tests): a headless `BlockNoteEditor.create({ collaboration: { fragment } })` is bound to the live `Y.XmlFragment` returned by `openDirectConnection.transact()`, mutated via `editor.transact(insertBlocks)`, and the resulting Yjs delta is shown to (a) flow through `HocuspocusSync`'s update listener into a `doc_updates` row + `outbox(doc.updated)` row inside the same write-path tx, (b) project back through a fresh `Y.Doc` replay of the durable update stream, and (c) roll back atomically with the outer SQL tx (the editor-mutate row never lands; the resident Y.Doc is evicted via `BoundSyncService.rollback`, so the next read rehydrates from committed updates and the rolled-back content is invisible). Empirical finding from this slice: `BlockNoteEditor` server-side mutation requires a DOM shim — without `editor.mount(host)`, `insertBlocks` is a silent no-op because the y-prosemirror collab plugin only writes back to the fragment via `view.dispatch`. Verified for `insertBlocks` under `happy-dom`; same dispatch path covers `updateBlock` / `removeBlocks` by mechanism but only `insertBlocks` was exercised. BlockNote's own test suite runs under `jsdom` — substrate selection (jsdom vs happy-dom) and the mutation-method coverage matrix are surface-adapter-slice questions, not new ADR triggers. Lower-level evidence still applies (`packages/sync/src/hocuspocus.integration.test.ts` for the no-WS sync contract; `packages/dispatcher/src/writepath.integration.test.ts` for dispatcher-level rollback-rehydration). **Still required to close item 11 fully:** the WS-client concurrent-edit case from the original spec — a second client holding an open `WebSocketProvider` while the agent edits via direct connection — which depends on the Phase 4 broadcast-buffering-until-commit fix (see ADR 0018 § "Out of scope").
12. **Write-path single-tx crash-fuzz** (`packages/dispatcher/prop/writepath-atomicity.test.ts`, F31). **Status: CLOSED for content mutations** (P3.6e commit 2, `a9ca821`). Metadata-only mutations have no `doc_updates` pair and are not in scope of this fuzz; their atomicity is covered by `packages/api-server/prop/metadata-only-atomicity.test.ts` — see item 16 below, CLOSED.
13. **Reconcile-base-token flow** to be validated end-to-end with a minimal HTTP agent: `doc.get_markdown → edit → doc.update_from_markdown` survives concurrent human edit (F66/F73). Token issuance is currently deferred in the `docGet` handler (`packages/capabilities/src/doc/get.ts`) until `doc.update_from_markdown` lands.
14. **Redis partition revocation** (`packages/sync/test/revocation-redis-partition.prop.ts`, F49) — to be green.
15. **SQLite load-ceiling validation** (F48) — to be confirmed by the `packages/db/test/sqlite-ceiling.report.md` deliverable from item 8 above. Status follows item 8: closed when that report file exists and meets the ADR 0007 envelope.
16. **Metadata-only mutation atomicity** (ADR 0018 § Out of scope; `METADATA_ONLY_CAPABILITIES` in `packages/scopes`). Capabilities like `block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.delete`, `doc.restore`, `doc.move`, `collection.*` commit without a `doc_updates` pair and are therefore *not* covered by item 12's write-path crash-fuzz. **Status: CLOSED** (2026-04-21). Closure artifact is `packages/api-server/prop/metadata-only-atomicity.test.ts` — N-way fault-injection property test that exercises the real `createApiDispatcher` factory via a plugin-wrapped driver and asserts the four-row tuple (`docs` UPDATE + `audit_events(allow)` + `outbox(audit.appended)` + handler-emitted `outbox(*)`) commits all-or-none under fault at every in-tx query position. Fixture capability is `doc.publish`; every other metadata-only capability runs through the same queue-and-flush primitive in `createApiDispatcher` and is covered by the same property. Implementation half (handler-emitted `ctx.outbox(...)` un-stubbed at the trunk) landed in the same slice: `createApiDispatcher.ts` queues handler events during `fn(extras, auditTx)` and flushes them via `createOutboxWriter().append(auditTx, …)` before `withSystemTx` commits.

When all entries are CLOSED, the verification stack is real. Subsequent capability implementations ride the same tracks.

**Gate status (2026-04-19): unsatisfied, revision pending.** The P3.7 status sweep in `docs/continuation.md` § Immediate focus → P3.7 is the single live source for current counts; do not duplicate them here. That matrix shows the current rule is unsatisfied by the tree today, and most OPEN items are Phase-4 substance by shape (surface adapters, ops scaffolding, reconcile flow, embeddings, distributed primitives) — so under the rule as written, Phase 4 is blocked indefinitely. The matrix is therefore **a diagnostic input to the gate decision, not a gate itself**. The gate rule above is pending explicit revision at phase-boundary review with @numman — the decision is captured as Open Question 3 in `docs/continuation.md` and must name a minimum-CLOSED set + a deferral bucket for each remaining item before Phase 4 entry is executable.
