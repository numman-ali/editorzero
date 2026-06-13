/**
 * Postgres DDL — the dialect-parallel counterpart to `sqlite-ddl.ts`
 * (ADR 0023). Same tables, same constraints, same indexes; type
 * mappings differ:
 *
 *   TEXT          → TEXT               (unchanged)
 *   BLOB          → BYTEA              (Uint8Array columns)
 *   INTEGER (64)  → BIGINT             (epoch-ms timestamps, seq, next_seq, delete_after)
 *   INTEGER (32)  → INTEGER            (bounded counters — visibility_version,
 *                                       collapsed_count, duration_ms)
 *
 * The 64-vs-32 split is load-bearing (ADR 0023 §4). pg's default `int8`
 * parser returns string, which would break every `z.number()` timestamp
 * contract silently — the per-pool `types` override in `postgres.ts`
 * coerces OID 20 (int8) back to Number at pool construction. INTEGER
 * columns are already OID 23 (int4) and parse as Number natively.
 *
 * Two consumers import from here:
 *
 *  - Integration + conformance tests that spin a fresh Postgres
 *    (testcontainers or `EDITORZERO_TEST_POSTGRES_URL` override) and
 *    apply the schema.
 *  - The `@editorzero/runtime` composition package when it grows a
 *    Postgres boot path.
 *
 * As with the SQLite DDL, this is the hand-written migration body
 * until Atlas + `kysely-codegen` (ADR 0007) take over; when they do,
 * `./../generated/*.ts` supersedes both files and this module collapses
 * to a compatibility shim during the migration window.
 *
 * Keep in lockstep with `./sqlite-ddl.ts` and `./../schema.ts` at the
 * same commit. A future coherence-script pairwise check will catch
 * drift; today it is a pairwise read.
 */

/**
 * `workspaces` — the tenant-scope root. Parallel to `sqlite-ddl.ts`
 * WORKSPACES_DDL; see that header for the self-scope + diagnostic_salt
 * + partial-slug-unique rationale.
 *
 * Type mappings from the SQLite dialect:
 *   BLOB    → BYTEA        (diagnostic_salt: `Uint8Array` column)
 *   INTEGER → BIGINT       (created_at, deleted_at — epoch-ms)
 *   INTEGER → INTEGER      (trash_retention_days, bounded counter)
 */
export const WORKSPACES_DDL = `
  CREATE TABLE workspaces (
    id                   TEXT    PRIMARY KEY,
    slug                 TEXT    NOT NULL,
    name                 TEXT    NOT NULL,
    trash_retention_days INTEGER NOT NULL DEFAULT 30
      CHECK (trash_retention_days BETWEEN 7 AND 365),
    diagnostic_salt      BYTEA   NOT NULL,
    created_by           TEXT    NOT NULL,
    created_at           BIGINT  NOT NULL,
    deleted_at           BIGINT,
    settings             TEXT    NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX workspaces_slug_unique
    ON workspaces(slug)
    WHERE deleted_at IS NULL;
` as const;

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
    published_at    BIGINT,
    render_version  INTEGER NOT NULL DEFAULT 0,
    created_by      TEXT NOT NULL,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    deleted_at      BIGINT,
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
 * Parallel to the SQLite DDL; see \`sqlite-ddl.ts\` COLLECTIONS_DDL
 * header for the rationale on the self-referencing composite FK and
 * the two partial unique indexes.
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
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL,
    deleted_at   BIGINT,
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

export const DOC_SNAPSHOTS_DDL = `
  CREATE TABLE doc_snapshots (
    id           TEXT PRIMARY KEY,
    doc_id       TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    seq          BIGINT NOT NULL,
    state        BYTEA NOT NULL,
    created_at   BIGINT NOT NULL,
    UNIQUE (doc_id, seq),
    FOREIGN KEY (doc_id, workspace_id) REFERENCES docs(id, workspace_id)
  );
` as const;

export const DOC_UPDATES_DDL = `
  CREATE TABLE doc_updates (
    id             TEXT PRIMARY KEY,
    doc_id         TEXT NOT NULL,
    workspace_id   TEXT NOT NULL,
    seq            BIGINT NOT NULL,
    update_blob    BYTEA NOT NULL,
    principal_kind TEXT NOT NULL,
    principal_id   TEXT NOT NULL,
    session_id     TEXT,
    created_at     BIGINT NOT NULL,
    delete_after   BIGINT,
    UNIQUE (doc_id, seq),
    FOREIGN KEY (doc_id, workspace_id) REFERENCES docs(id, workspace_id)
  );
` as const;

export const DOC_COUNTERS_DDL = `
  CREATE TABLE doc_counters (
    doc_id     TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
    next_seq   BIGINT NOT NULL DEFAULT 1,
    updated_at BIGINT NOT NULL
  );
` as const;

export const WORKSPACE_MEMBERS_DDL = `
  CREATE TABLE workspace_members (
    workspace_id TEXT   NOT NULL,
    user_id      TEXT   NOT NULL,
    role         TEXT   NOT NULL CHECK (role IN ('owner','admin','member','guest')),
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL,
    deleted_at   BIGINT,
    PRIMARY KEY (workspace_id, user_id)
  );
` as const;

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
    created_at        BIGINT NOT NULL,
    collapsed_count   INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX audit_by_workspace_time ON audit_events(workspace_id, created_at);
  CREATE INDEX audit_by_subject ON audit_events(subject_kind, subject_id, created_at);
` as const;

export const OUTBOX_DDL = `
  CREATE TABLE outbox (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT,
    event         TEXT NOT NULL,
    payload       TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    forwarded_at  BIGINT,
    forwarded_to  TEXT
  );
` as const;

/**
 * \`spaces\` — the ADR 0040 Model B membership ceiling. Parallel to
 * the SQLite DDL; see \`sqlite-ddl.ts\` SPACES_DDL header for the
 * constraint rationale (composite-FK target, kind↔owner CHECK,
 * baseline_access excluding 'owner', the two partial unique indexes).
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
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    deleted_at      BIGINT,
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
 * \`space_members\` — Space membership on the GRANT_ROLES ladder.
 * Parallel to the SQLite DDL; see \`sqlite-ddl.ts\` SPACE_MEMBERS_DDL
 * header (composite FK per F99, hard-DELETE lifecycle, by-user index).
 */
export const SPACE_MEMBERS_DDL = `
  CREATE TABLE space_members (
    workspace_id TEXT    NOT NULL,
    space_id     TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    role         TEXT    NOT NULL CHECK (role IN ('owner','edit','comment','view')),
    created_at   BIGINT NOT NULL,
    updated_at   BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, space_id, user_id),
    FOREIGN KEY (space_id, workspace_id) REFERENCES spaces(id, workspace_id)
  );
  CREATE INDEX space_members_by_user
    ON space_members(workspace_id, user_id);
` as const;

/**
 * \`grants\` — the single polymorphic ACL table (ADR 0040 fork #3).
 * Parallel to the SQLite DDL; see \`sqlite-ddl.ts\` GRANTS_DDL header
 * for why there is deliberately NO composite FK (H6) and which named
 * controls compensate (edge-unique index, the two lookup indexes, the
 * Step-6 fuzzer, the Step-8 handler check). \`is_guest\` stays
 * INTEGER 0/1 in BOTH dialects (not BOOLEAN) so the Kysely column type
 * is one cross-backend \`number\` — the same reasoning as epoch-ms
 * timestamps, applied to a flag.
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
    created_at    BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX grants_edge_unique
    ON grants(workspace_id, resource_kind, resource_id, subject_kind, subject_id);
  CREATE INDEX grants_by_subject
    ON grants(workspace_id, subject_kind, subject_id, is_guest);
  CREATE INDEX grants_by_resource
    ON grants(workspace_id, resource_kind, resource_id);
` as const;

/**
 * \`agents\` — agent principals (ADR 0044); dialect-parallel to the
 * SQLite block (see its docstring for the owner-liveness, terminal-
 * revocation, and F99 composite-FK-target rationale). Timestamps are
 * BIGINT epoch-ms (the cross-backend \`number\` rule).
 */
export const AGENTS_DDL = `
  CREATE TABLE agents (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    owner_user_id TEXT    NOT NULL,
    created_by    TEXT    NOT NULL,
    created_at    BIGINT  NOT NULL,
    updated_at    BIGINT  NOT NULL,
    revoked_at    BIGINT,
    UNIQUE (id, workspace_id)
  );
  CREATE UNIQUE INDEX agents_name_unique
    ON agents(workspace_id, name)
    WHERE revoked_at IS NULL;
  CREATE INDEX agents_by_owner
    ON agents(workspace_id, owner_user_id);
` as const;

/**
 * \`agent_tokens\` — owned bearer credentials (ADR 0044 Decision 1);
 * dialect-parallel to the SQLite block (global \`token_hash\`
 * uniqueness, composite FK to \`agents(id, workspace_id)\`, JSON
 * \`scopes\`, display-only \`tier\`).
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
    created_at    BIGINT  NOT NULL,
    expires_at    BIGINT,
    revoked_at    BIGINT,
    FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id)
  );
  CREATE UNIQUE INDEX agent_tokens_hash_unique
    ON agent_tokens(token_hash);
  CREATE INDEX agent_tokens_by_agent
    ON agent_tokens(workspace_id, agent_id);
` as const;

/**
 * Full DDL applied at driver bootstrap. Same concatenation order as
 * the SQLite parallel — \`docs\` must precede the child tables that FK
 * into it, \`spaces\` precedes \`space_members\`, and \`agents\`
 * precedes \`agent_tokens\`. Other orderings are free.
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
 * Drop-everything counterpart to `FULL_DDL`, DERIVED from it: every
 * `CREATE TABLE <name>` statement contributes a `DROP TABLE IF EXISTS
 * <name> CASCADE`, emitted in REVERSE create order (children before
 * parents — a table only ever FKs to earlier tables; CASCADE is
 * belt-and-braces on top). Derivation means a new table can never be
 * forgotten by a test harness's hand-maintained reset list — the
 * agents slice tripped that drift in THREE separate copies of the old
 * literal list in one commit (db unit, db integration backends,
 * api-server fuzzer).
 */
export const FULL_DDL_DROP = FULL_DDL.split("\n")
  .map((line) => /^\s*CREATE TABLE (\w+)/.exec(line)?.[1])
  .filter((t): t is string => t !== undefined)
  .reverse()
  .map((t) => `DROP TABLE IF EXISTS ${t} CASCADE;`)
  .join("\n");
