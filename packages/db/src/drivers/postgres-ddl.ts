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

export const DOCS_DDL = `
  CREATE TABLE docs (
    id                 TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL,
    collection_id      TEXT,
    title              TEXT NOT NULL,
    slug               TEXT NOT NULL,
    order_key          TEXT NOT NULL,
    visibility         TEXT NOT NULL DEFAULT 'workspace',
    visibility_version INTEGER NOT NULL DEFAULT 0,
    created_by         TEXT NOT NULL,
    created_at         BIGINT NOT NULL,
    updated_at         BIGINT NOT NULL,
    deleted_at         BIGINT,
    UNIQUE (id, workspace_id)
  );
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
 * Full DDL applied at driver bootstrap. Same concatenation order as
 * the SQLite parallel — `docs` must precede the child tables that FK
 * into it. Other orderings are free.
 */
export const FULL_DDL = [
  DOCS_DDL,
  DOC_SNAPSHOTS_DDL,
  DOC_UPDATES_DDL,
  DOC_COUNTERS_DDL,
  AUDIT_EVENTS_DDL,
  OUTBOX_DDL,
].join("\n");
