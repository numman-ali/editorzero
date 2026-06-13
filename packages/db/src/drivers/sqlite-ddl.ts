/**
 * SQLite DDL for the tables this slice of `@editorzero/db` declares.
 *
 * The long-term source of truth is Atlas + `kysely-codegen`
 * (architecture.md §16.9). Until that pipeline lands, this file is
 * the hand-written migration body. Two consumers import from here:
 *
 *  - Unit + integration tests that construct an in-memory SQLite
 *    driver and need real tables behind it.
 *  - The `@editorzero/runtime` composition package (P3.5 commit 4)
 *    that bootstraps a workspace-local SQLite file at first run.
 *
 * Not importing DDL into production handlers is deliberate — no
 * capability handler should ever execute raw DDL. The
 * `no-raw-kysely-outside-db` coherence check keeps raw Kysely pinned
 * to `packages/db/**` already; the same reasoning applies to the DDL
 * strings here.
 *
 * Schema shapes mirror `./../schema.ts` (the Kysely `Database`
 * interface) and architecture.md §3.5 – §3.11. Keep them in sync at
 * the same commit; the coherence script will eventually enforce the
 * mapping but today it is a pairwise read between the two files.
 */

/**
 * `workspaces` — the tenant-scope root (architecture.md §3.2).
 *
 * `id` IS the workspace id — this is the only self-scoped table in v1
 * (`TENANT_SCOPE_COLUMNS.workspaces === "id"`; the scoping plugin
 * emits `id = <scope>` rather than `workspace_id = <scope>` for this
 * table). No FK declarations — the other tables that reference
 * `workspace_id` still have no SQL FK to `workspaces` (matches the
 * `workspace_members` pattern; FKs land with Atlas + kysely-codegen,
 * architecture.md §16.9).
 *
 * `slug` unique per workspace for URL routing (`<slug>.<root-host>`
 * subdomain + custom-domain fallback). Partial unique index excludes
 * soft-deleted rows so a restored workspace doesn't collide with a
 * replacement minted after its delete. Inline `UNIQUE` from the
 * architecture spec is *intent* — the partial index is the actual
 * enforcement, same NULL-aware-soft-delete reason the collections /
 * docs slug indexes use.
 *
 * `diagnostic_salt` (BLOB, 16 bytes) — per-workspace HMAC salt (F64)
 * used by future `admin.diagnose` for content redaction. Rotated by
 * `admin.secret_rotate --kind=diagnostic_salt` (future). Generated at
 * workspace creation via `crypto.randomBytes(16)`; NOT derivable from
 * any other field.
 *
 * `trash_retention_days` bounded to [7, 365] (ADR 0017). Default 30.
 * Updatable by `workspace.update`.
 *
 * `settings` — JSON-serialised opaque map, default `'{}'`. v1 has no
 * defined settings; the column exists so `workspace.update` can store
 * arbitrary structured preferences without a per-field migration.
 *
 * No `updated_at` — matches architecture.md §3.2 exactly. Workspace
 * reads are single-row-by-principal; no listing-by-freshness query
 * consumes the column today.
 */
export const WORKSPACES_DDL = `
  CREATE TABLE workspaces (
    id                   TEXT    PRIMARY KEY,
    slug                 TEXT    NOT NULL,
    name                 TEXT    NOT NULL,
    trash_retention_days INTEGER NOT NULL DEFAULT 30
      CHECK (trash_retention_days BETWEEN 7 AND 365),
    diagnostic_salt      BLOB    NOT NULL,
    created_by           TEXT    NOT NULL,
    created_at           INTEGER NOT NULL,
    deleted_at           INTEGER,
    settings             TEXT    NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX workspaces_slug_unique
    ON workspaces(slug)
    WHERE deleted_at IS NULL;
` as const;

/**
 * `docs` — canonical metadata row per document (architecture.md §3.5).
 *
 * `UNIQUE (id, workspace_id)` is the target for the composite FK from
 * `doc_snapshots` and `doc_updates` (F99). SQLite's FK machinery needs
 * a UNIQUE or PRIMARY KEY index covering exactly the referenced
 * column list; adding `workspace_id` to the unique tuple gives that
 * index without changing the effective row identity (`id` is already
 * the PK). The practical effect: a child row can only pair `doc_id =
 * X` with the one `workspace_id` that row X actually belongs to.
 *
 * Read-scope vs publish are ORTHOGONAL dimensions (ADR 0040 Step 5,
 * the `visibility` de-overload):
 *  - \`access_mode ∈ {space, private}\` — who inside the Org can read
 *    (space-mediated vs allow-list). No live capability mutates it yet;
 *    the mode switch lands with the Step-8 ACL family.
 *  - \`published_slug\`/\`published_at\` — the public dimension.
 *    Non-null \`published_at\` ⇒ published; \`published_slug\` is the
 *    workspace-unique public URL segment (\`docs_published_slug_unique\`
 *    — soft-deleted rows excluded so a trashed doc never blocks a
 *    reuse). Set by \`doc.publish\`, cleared by \`doc.unpublish\` AND by
 *    \`doc.soft_delete\` (a trashed doc must leave the public site;
 *    restore must never surprise-republish).
 *  - \`render_version\` — render/cache-invalidation counter (F5),
 *    bumped by publish/unpublish/delete/restore. Renamed from the
 *    legacy \`visibility_version\` at the Step-5 split (§3.5 records
 *    the rename decision).
 */
export const DOCS_DDL = `
  CREATE TABLE docs (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    collection_id   TEXT,
    title           TEXT NOT NULL,
    slug            TEXT NOT NULL,
    order_key       TEXT NOT NULL,
    access_mode     TEXT NOT NULL DEFAULT 'space' CHECK (access_mode IN ('space','private')),
    published_slug  TEXT,
    published_at    INTEGER,
    render_version  INTEGER NOT NULL DEFAULT 0,
    created_by      TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    deleted_at      INTEGER,
    UNIQUE (id, workspace_id)
  );
  CREATE UNIQUE INDEX docs_root_slug_unique
    ON docs(workspace_id, slug)
    WHERE collection_id IS NULL AND deleted_at IS NULL;
  CREATE UNIQUE INDEX docs_nested_slug_unique
    ON docs(workspace_id, collection_id, slug)
    WHERE collection_id IS NOT NULL AND deleted_at IS NULL;
  CREATE UNIQUE INDEX docs_published_slug_unique
    ON docs(workspace_id, published_slug)
    WHERE published_slug IS NOT NULL AND deleted_at IS NULL;
` as const;

/**
 * \`collections\` — folder-tree primitive (architecture.md §3.5).
 *
 * Self-referencing FK on \`(parent_id, workspace_id) REFERENCES
 * collections(id, workspace_id)\` — same composite-FK pattern as
 * \`doc_snapshots/doc_updates → docs\` (F99). A cousin collection in
 * another workspace can never be the parent, even if an attacker
 * somehow invents a matching \`parent_id\`.
 *
 * Slug uniqueness is per \`(workspace_id, parent_id)\` — but SQL's
 * \`UNIQUE (workspace_id, parent_id, slug)\` treats NULL as distinct,
 * which would let two root-level collections collide on slug. Two
 * partial unique indexes express the intended invariant correctly:
 * one for \`parent_id IS NULL\` (root siblings unique by slug), one
 * for the non-null case (nested siblings unique by slug within their
 * parent). Soft-deleted rows are excluded so a restored collection
 * doesn't silently conflict with a replacement minted after its
 * deletion.
 */
export const COLLECTIONS_DDL = `
  CREATE TABLE collections (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    parent_id    TEXT,
    space_id     TEXT,
    title        TEXT NOT NULL,
    slug         TEXT NOT NULL,
    order_key    TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    UNIQUE (id, workspace_id),
    FOREIGN KEY (parent_id, workspace_id) REFERENCES collections(id, workspace_id)
  );
  CREATE UNIQUE INDEX collections_root_slug_unique
    ON collections(workspace_id, slug)
    WHERE parent_id IS NULL AND deleted_at IS NULL;
  CREATE UNIQUE INDEX collections_nested_slug_unique
    ON collections(workspace_id, parent_id, slug)
    WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
` as const;

/**
 * `doc_snapshots` — compacted Y.Doc state per `seq` (architecture.md §3.7).
 *
 * F99: composite FK `(doc_id, workspace_id) REFERENCES docs(id,
 * workspace_id)` is the DB-level guard against `workspace_id` on a
 * child row drifting away from the owning `docs` row. The scoping
 * plugin enforces `workspace_id = <scope>` on every query, but it
 * does not verify that `doc_id` actually belongs to that workspace —
 * without this FK, a bug (or the unscoped system handle) could pair
 * a valid `doc_id` with a wrong `workspace_id` and corrupt the
 * replay path silently. `PRAGMA foreign_keys = ON` is set at
 * connection open (ADR 0007); the FK fires at write time.
 */
export const DOC_SNAPSHOTS_DDL = `
  CREATE TABLE doc_snapshots (
    id           TEXT PRIMARY KEY,
    doc_id       TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    state        BLOB NOT NULL,
    created_at   INTEGER NOT NULL,
    UNIQUE (doc_id, seq),
    FOREIGN KEY (doc_id, workspace_id) REFERENCES docs(id, workspace_id)
  );
` as const;

/**
 * `doc_updates` — append-only journal of Yjs updates (architecture.md §3.7).
 *
 * F99: see `DOC_SNAPSHOTS_DDL` for the composite FK rationale —
 * same guard, same rationale.
 */
export const DOC_UPDATES_DDL = `
  CREATE TABLE doc_updates (
    id             TEXT PRIMARY KEY,
    doc_id         TEXT NOT NULL,
    workspace_id   TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    update_blob    BLOB NOT NULL,
    principal_kind TEXT NOT NULL,
    principal_id   TEXT NOT NULL,
    session_id     TEXT,
    created_at     INTEGER NOT NULL,
    delete_after   INTEGER,
    UNIQUE (doc_id, seq),
    FOREIGN KEY (doc_id, workspace_id) REFERENCES docs(id, workspace_id)
  );
` as const;

/**
 * `doc_counters` — per-doc `next_seq` row-lock target (architecture.md §6.4).
 * `ON DELETE CASCADE` keeps the counter row lifetime tied to the doc's
 * hard-delete (separate from soft-delete / `docs.deleted_at`, which
 * leaves the counter intact because restore reuses the seq space).
 */
export const DOC_COUNTERS_DDL = `
  CREATE TABLE doc_counters (
    doc_id     TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
    next_seq   INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
` as const;

/**
 * `workspace_members` — user↔workspace membership with role (architecture.md
 * §3.4; ADR 0024). Composite PK `(workspace_id, user_id)` — one active
 * membership per user-per-workspace. `role` CHECK-constrained to the
 * four-value `Role` union; the resolver maps `role` → `Role[]` at
 * principal-projection time, and `ROLE_SCOPES` in
 * `packages/dispatcher/src/gate.ts` projects `Role[]` → `Scope[]`.
 *
 * `deleted_at` for ADR 0017 cascade — workspace soft-delete transitively
 * soft-deletes all member rows. Re-adding a previously-removed member is
 * a `deleted_at = NULL` UPDATE (revive-in-place), never a second INSERT
 * (composite PK would collide); `workspace.add_member` (future slice)
 * codifies this in its handler contract.
 *
 * No FK declarations — the `docs` table also references `workspace_id`
 * without an FK for the same "cross-DDL independence" reason, and the
 * `user_id` target table is owned by Better Auth (`user`, singular;
 * default `modelName`, not overridden in `create-auth.ts`). FKs land
 * when Atlas + kysely-codegen take over schema management
 * (architecture.md §16.9).
 *
 * Scoped on `workspace_id` via `TENANT_SCOPE_COLUMNS` — every
 * capability read through `ctx.db` auto-filters to the tenant. The
 * auth resolver still reads via `driver.system()` because it runs
 * before a tenant context exists (the resolver *mints* that context
 * via `load-roles.ts`).
 */
export const WORKSPACE_MEMBERS_DDL = `
  CREATE TABLE workspace_members (
    workspace_id TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    role         TEXT    NOT NULL CHECK (role IN ('owner','admin','member','guest')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    PRIMARY KEY (workspace_id, user_id)
  );
` as const;

/**
 * `audit_events` — every outcome of every capability invocation
 * (architecture.md §3.11). Two indexes per the architecture document.
 */
export const AUDIT_EVENTS_DDL = `
  CREATE TABLE audit_events (
    id                TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    capability_id     TEXT NOT NULL,
    category          TEXT NOT NULL,
    principal_kind    TEXT NOT NULL,
    principal_id      TEXT NOT NULL,
    acting_as_user_id TEXT,
    session_id        TEXT,
    token_id          TEXT,
    subject_kind      TEXT NOT NULL,
    subject_id        TEXT,
    outcome           TEXT NOT NULL,
    deny_reason       TEXT,
    input_hash        TEXT NOT NULL,
    effect            TEXT NOT NULL,
    duration_ms       INTEGER NOT NULL,
    trace_id          TEXT,
    created_at        INTEGER NOT NULL,
    collapsed_count   INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX audit_by_workspace_time ON audit_events(workspace_id, created_at);
  CREATE INDEX audit_by_subject ON audit_events(subject_kind, subject_id, created_at);
` as const;

/**
 * `outbox` — transactional-outbox rows emitted in the write-path tx
 * (architecture.md §6.3). Nullable `workspace_id` supports system-level
 * events; see `schema.ts` comment for why this table is not
 * tenant-scoped.
 */
export const OUTBOX_DDL = `
  CREATE TABLE outbox (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT,
    event         TEXT NOT NULL,
    payload       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    forwarded_at  INTEGER,
    forwarded_to  TEXT
  );
` as const;

/**
 * \`spaces\` — the ADR 0040 Model B membership ceiling. Constraints,
 * in order of intent:
 *  - \`UNIQUE (id, workspace_id)\` — composite-FK target for
 *    \`space_members\` (F99 tenant-integrity pattern).
 *  - the kind↔owner CHECK — a \`personal\` space carries its owner,
 *    a \`team\` space carries NULL; no third state is representable.
 *  - \`baseline_access\` excludes \`'owner'\` — it is the implicit role
 *    an \`open\` space confers on non-member Org members; an implicit
 *    everyone-is-owner is never valid.
 *  - \`spaces_slug_unique\` — live spaces are unique by slug per
 *    workspace (soft-deleted rows excluded, same posture as
 *    collections).
 *  - \`spaces_personal_unique\` — at most ONE live personal space per
 *    member (the Step-8 signup seeding relies on this being a
 *    constraint, not a convention).
 */
export const SPACES_DDL = `
  CREATE TABLE spaces (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('team','personal')),
    type            TEXT NOT NULL CHECK (type IN ('open','closed','private')),
    owner_user_id   TEXT,
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    baseline_access TEXT NOT NULL CHECK (baseline_access IN ('edit','comment','view')),
    created_by      TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    deleted_at      INTEGER,
    UNIQUE (id, workspace_id),
    CHECK ((kind = 'personal') = (owner_user_id IS NOT NULL))
  );
  CREATE UNIQUE INDEX spaces_slug_unique
    ON spaces(workspace_id, slug)
    WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX spaces_personal_unique
    ON spaces(workspace_id, owner_user_id)
    WHERE kind = 'personal' AND deleted_at IS NULL;
` as const;

/**
 * \`space_members\` — Space membership on the GRANT_ROLES ladder (the
 * ceiling rule compares membership roles to grant roles, so they share
 * one vocabulary — ADR 0040). Composite FK to \`spaces(id,
 * workspace_id)\` makes a wrong-tenant \`space_id\` unrepresentable
 * (F99). Hard-DELETE membership (no \`deleted_at\`) — the removal
 * effect carries the preimage. The \`(workspace_id, user_id)\` index
 * serves the "which Spaces am I in" read the Step-6 resolver runs on
 * every Space-scoped list.
 */
export const SPACE_MEMBERS_DDL = `
  CREATE TABLE space_members (
    workspace_id TEXT    NOT NULL,
    space_id     TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    role         TEXT    NOT NULL CHECK (role IN ('owner','edit','comment','view')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, space_id, user_id),
    FOREIGN KEY (space_id, workspace_id) REFERENCES spaces(id, workspace_id)
  );
  CREATE INDEX space_members_by_user
    ON space_members(workspace_id, user_id);
` as const;

/**
 * \`grants\` — the single polymorphic ACL table (ADR 0040 fork #3).
 * Deliberately NO composite FK (H6): \`resource_id\` is polymorphic
 * over \`resource_kind ∈ {space, doc}\` so no per-kind FK can exist.
 * The named compensating controls (binding, not advisory):
 *  - \`grants_edge_unique\` — one row per (resource, subject) edge;
 *    a re-grant is an UPDATE-shaped replace, never a duplicate row.
 *  - \`grants_by_subject\` — the "what can this principal see" path
 *    (the agent-speed read; \`is_guest\` included so guest enumeration
 *    is index-only).
 *  - \`grants_by_resource\` — the "who can see X" path.
 *  - The Step-6 isolation fuzzer (resource_id resolves within
 *    workspace_id) + the Step-8 handler same-tx existence check.
 * Hard-DELETE lifecycle (H1): no \`deleted_at\`/\`updated_at\`; revoke
 * removes the row, the audit effect carries the preimage, and rows
 * persist (inert) through their resource's soft-delete so restore
 * recovers the exact grant set.
 */
export const GRANTS_DDL = `
  CREATE TABLE grants (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    resource_kind TEXT    NOT NULL CHECK (resource_kind IN ('space','doc')),
    resource_id   TEXT    NOT NULL,
    subject_kind  TEXT    NOT NULL CHECK (subject_kind IN ('user','agent')),
    subject_id    TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('owner','edit','comment','view')),
    is_guest      INTEGER NOT NULL CHECK (is_guest IN (0,1)),
    created_by    TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX grants_edge_unique
    ON grants(workspace_id, resource_kind, resource_id, subject_kind, subject_id);
  CREATE INDEX grants_by_subject
    ON grants(workspace_id, subject_kind, subject_id, is_guest);
  CREATE INDEX grants_by_resource
    ON grants(workspace_id, resource_kind, resource_id);
` as const;

/**
 * \`agents\` — agent principals (ADR 0044). \`owner_user_id\` NOT NULL
 * (v1: every agent has a human owner; owner liveness gates bearer
 * resolution — no SQL FK to Better Auth's \`user\`, boundary rule).
 * \`revoked_at\` is terminal; the partial-unique name index frees the
 * name on revocation (live-name pattern). \`UNIQUE (id, workspace_id)\`
 * is the F99 composite-FK target for \`agent_tokens\`. The by-owner
 * index serves the revocation tap's \`workspace.member_remove\` arm
 * ("close sockets of agents owned by the removed user").
 */
export const AGENTS_DDL = `
  CREATE TABLE agents (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    owner_user_id TEXT    NOT NULL,
    created_by    TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    revoked_at    INTEGER,
    UNIQUE (id, workspace_id)
  );
  CREATE UNIQUE INDEX agents_name_unique
    ON agents(workspace_id, name)
    WHERE revoked_at IS NULL;
  CREATE INDEX agents_by_owner
    ON agents(workspace_id, owner_user_id);
` as const;

/**
 * \`agent_tokens\` — owned bearer credentials (ADR 0044 Decision 1).
 * \`token_hash\` (SHA-256 hex of the full secret) is GLOBALLY unique
 * across live + revoked rows — the schema encodes "one secret, at most
 * one row"; resolution is a full-digest indexed lookup. The composite
 * FK to \`agents(id, workspace_id)\` makes a wrong-tenant \`agent_id\`
 * pairing unrepresentable (F99) — \`agents\` precedes this table in
 * \`FULL_DDL\`. \`scopes\` is a JSON array validated at the capability
 * boundary; \`tier\` is the mint-time intent label, display-only
 * (never re-derived into scopes — tiers are computed-once at mint).
 */
export const AGENT_TOKENS_DDL = `
  CREATE TABLE agent_tokens (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    agent_id      TEXT    NOT NULL,
    token_hash    TEXT    NOT NULL,
    token_prefix  TEXT    NOT NULL,
    last4         TEXT    NOT NULL,
    scopes        TEXT    NOT NULL,
    tier          TEXT    NOT NULL CHECK (tier IN ('read-only','author','editor','admin','custom')),
    created_by    TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER,
    revoked_at    INTEGER,
    FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id)
  );
  CREATE UNIQUE INDEX agent_tokens_hash_unique
    ON agent_tokens(token_hash);
  CREATE INDEX agent_tokens_by_agent
    ON agent_tokens(workspace_id, agent_id);
` as const;

/**
 * The full DDL applied at driver bootstrap. Concatenation order
 * matters only for FK references — `docs` must come before
 * `doc_snapshots` / `doc_updates` / `doc_counters`, `spaces`
 * before `space_members`, and `agents` before `agent_tokens`.
 * `collections` is self-referential and has no FK dependency on
 * `docs`, so either order works; listing it first alongside docs
 * keeps the document-domain tables grouped at the top.
 */
export const FULL_DDL = [
  WORKSPACES_DDL,
  COLLECTIONS_DDL,
  DOCS_DDL,
  DOC_SNAPSHOTS_DDL,
  DOC_UPDATES_DDL,
  DOC_COUNTERS_DDL,
  WORKSPACE_MEMBERS_DDL,
  AUDIT_EVENTS_DDL,
  OUTBOX_DDL,
  SPACES_DDL,
  SPACE_MEMBERS_DDL,
  GRANTS_DDL,
  AGENTS_DDL,
  AGENT_TOKENS_DDL,
].join("\n");

/**
 * Drop-everything counterpart to `FULL_DDL`, DERIVED from it in
 * REVERSE create order (children before parents — a table only ever
 * FKs to earlier tables, and SQLite has no `DROP TABLE … CASCADE`).
 * Derivation means a new table can never be forgotten by a test
 * harness's hand-maintained reset list — see the Postgres parallel
 * for the drift story this closes.
 */
export const FULL_DDL_DROP = FULL_DDL.split("\n")
  .map((line) => /^\s*CREATE TABLE (\w+)/.exec(line)?.[1])
  .filter((t): t is string => t !== undefined)
  .reverse()
  .map((t) => `DROP TABLE IF EXISTS ${t};`)
  .join("\n");
