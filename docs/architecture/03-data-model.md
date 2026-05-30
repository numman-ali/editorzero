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

Never soft-deleted, never hard-deleted (ADR 0017). The `effect` column is the invariant's load-bearing field: replaying `effect` in `created_at` order from the empty initial state reproduces the final workspace state. See [§9 Audit and attribution](09-audit-and-attribution.md#9-audit-and-attribution) for the replay contract.

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

Resolution order (see [§8 Permission model](08-permission-model.md#8-permission-model)):
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
