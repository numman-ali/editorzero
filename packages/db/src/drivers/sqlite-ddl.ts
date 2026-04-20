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
 * `docs` — canonical metadata row per document (architecture.md §3.5).
 *
 * `UNIQUE (id, workspace_id)` is the target for the composite FK from
 * `doc_snapshots` and `doc_updates` (F99). SQLite's FK machinery needs
 * a UNIQUE or PRIMARY KEY index covering exactly the referenced
 * column list; adding `workspace_id` to the unique tuple gives that
 * index without changing the effective row identity (`id` is already
 * the PK). The practical effect: a child row can only pair `doc_id =
 * X` with the one `workspace_id` that row X actually belongs to.
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
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    deleted_at         INTEGER,
    UNIQUE (id, workspace_id)
  );
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
 * No FK declarations — `workspaces` is not yet in our DDL (the `docs`
 * table also references `workspace_id` without an FK for the same
 * reason), and the `user_id` target table is owned by Better Auth
 * (`user`, singular; default `modelName`, not overridden in
 * `create-auth.ts`). FKs land when Atlas + kysely-codegen take over
 * schema management (architecture.md §16.9).
 *
 * Read by the auth resolver via `driver.system()` with an explicit
 * `workspace_id` filter — `workspace_members` is not yet in
 * `TENANT_SCOPED_TABLES` because no capability consumes it through a
 * tenant-scoped handle today; the `workspace.list_members` /
 * `workspace.add_member` slices will add it to that list in lockstep
 * with the capability declarations.
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
 * The full DDL applied at driver bootstrap. Concatenation order
 * matters only for FK references — `docs` must come before
 * `doc_snapshots` / `doc_updates` / `doc_counters`. Other orderings
 * are free.
 */
export const FULL_DDL = [
  DOCS_DDL,
  DOC_SNAPSHOTS_DDL,
  DOC_UPDATES_DDL,
  DOC_COUNTERS_DDL,
  WORKSPACE_MEMBERS_DDL,
  AUDIT_EVENTS_DDL,
  OUTBOX_DDL,
].join("\n");
