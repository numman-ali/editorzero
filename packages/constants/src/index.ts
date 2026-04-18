/**
 * Numeric constants — single source of truth.
 *
 * Every magic number referenced in docs, ADRs, or code lives here.
 * Docs cite constants by name (e.g. `DOC_UPDATE_TOMBSTONE_FLOOR_MS`); the
 * coherence script fails a commit that introduces a matching literal
 * outside this file.
 *
 * Conventions:
 *   - All time values are milliseconds. Suffix `_MS`.
 *   - Byte counts end with `_BYTES`.
 *   - Counts-per-window end with `_PER_MIN` / `_PER_SEC` / `_PER_DAY`.
 *   - Ceilings and budgets end with `_CEILING` or `_BUDGET`.
 */

// ── Time helpers (not exported; expand inline) ─────────────────────────────
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ── Retention / GC floors (architecture.md §3.7, §3.10a, §3.18, §18.1) ─────

/** Doc-update tombstone floor before the reaper GCs. Matches `max(72h, RPO)`. */
export const DOC_UPDATE_TOMBSTONE_FLOOR_MS: number = 72 * HOUR_MS;

/** Reconcile-base token TTL (§3.18 — same floor as doc_updates). */
export const RECONCILE_BASE_TOKEN_TTL_MS: number = 72 * HOUR_MS;

/** Attachment soft-delete grace before hard-delete (§3.10 step 2). */
export const ATTACHMENT_SOFT_DELETE_GRACE_MS: number = 24 * HOUR_MS;

/** Pending-upload TTL; client must confirm within this window (§3.10b). */
export const PENDING_UPLOAD_TTL_MS: number = 10 * MINUTE_MS;

/** Orphan-upload reaper lookback — reap pending uploads older than this past expiry. */
export const PENDING_UPLOAD_REAPER_LOOKBACK_MS: number = 1 * HOUR_MS;

/** Signed upload URL TTL (§3.10a step 1). */
export const SIGNED_UPLOAD_URL_TTL_MS: number = 10 * MINUTE_MS;

/** Signed fetch URL TTL (§3.10a — `attachment.get`). */
export const SIGNED_FETCH_URL_TTL_MS: number = 5 * MINUTE_MS;

/** Tool-call resume window for interrupted MCP calls (§15.4). */
export const MCP_TOOL_CALL_RESUME_MS: number = 24 * HOUR_MS;

/** Workspace trash default retention (§3.2 — configurable [7, 365] days). */
export const WORKSPACE_TRASH_DEFAULT_DAYS: number = 30;
export const WORKSPACE_TRASH_MIN_DAYS: number = 7;
export const WORKSPACE_TRASH_MAX_DAYS: number = 365;

// ── Size / byte caps (ADR 0003, §3.10a, §10.4) ─────────────────────────────

/** Default per-attachment upload cap (§3.10a). Operator-tunable. */
export const ATTACHMENT_MAX_BYTES_DEFAULT: number = 100 * 1024 * 1024;

/** Per-Yjs-update reject-on-breach cap (ADR 0003 / §10.4). */
export const YJS_UPDATE_MAX_BYTES: number = 256 * 1024;

/** Per-doc state cap; breach triggers read-only + admin flag (§10.4). */
export const DOC_STATE_MAX_BYTES: number = 50 * 1024 * 1024;

// ── Real-time throughput + lag budgets (§10.4, §10.3) ──────────────────────

/** Max sustained updates/sec on a single session before session drop (§10.4). */
export const SESSION_UPDATES_PER_SEC_CEILING: number = 100;

/** Doc-level write-path throughput target (§17.1a SQLite load-ceiling). */
export const DOC_WRITE_PATH_TARGET_PER_SEC: number = 500;

/** Event-loop p99 lag budget (§10.4 — first ceiling to bite on small hosts). */
export const EVENT_LOOP_LAG_P99_BUDGET_MS: number = 50;
export const EVENT_LOOP_LAG_P99_ALERT_MS: number = 100;

/** Write-path p99 latency target at declared SQLite ceiling (§17.1a). */
export const WRITE_PATH_P99_LATENCY_BUDGET_MS: number = 1_000;

// ── Hocuspocus / doc residency (§10.3, §10.5) ──────────────────────────────

/** Per-doc serializer inactive TTL while sessions heartbeat (§10.5). */
export const HOCUSPOCUS_INACTIVE_TTL_ACTIVE_MS: number = 300 * SECOND_MS;

/** Inactive TTL when no session has heartbeated recently. */
export const HOCUSPOCUS_INACTIVE_TTL_IDLE_MS: number = 60 * SECOND_MS;

/** Heartbeat window for "active session" determination (§10.5). */
export const HOCUSPOCUS_HEARTBEAT_WINDOW_MS: number = 60 * SECOND_MS;

/** Manager per-doc Redis lease TTL during rebalance (§10.1 / §6.4). */
export const MANAGER_LEASE_TTL_MS: number = 5 * SECOND_MS;

/** New-manager drain window after old lease expiry — 2× lease TTL (§6.4). */
export const MANAGER_DRAIN_WINDOW_MS: number = 2 * MANAGER_LEASE_TTL_MS;

/** Forced re-authentication interval (lower bound) for open sessions (§10.3). */
export const SESSION_REAUTH_INTERVAL_MIN_MS: number = 8 * MINUTE_MS;

/** Forced re-authentication interval (upper bound) for open sessions (§10.3). */
export const SESSION_REAUTH_INTERVAL_MAX_MS: number = 12 * MINUTE_MS;

/** Revocation-log poll interval (§10.3 — belt-and-suspenders for Redis outage). */
export const REVOCATION_POLL_INTERVAL_MS: number = 1 * SECOND_MS;

/** Revocation latency target via primary pub/sub path (§10.3). */
export const REVOCATION_P99_PRIMARY_MS: number = 500;

/** Revocation latency target via poller fallback under Redis partition. */
export const REVOCATION_P99_FALLBACK_MS: number = 5 * SECOND_MS;

// ── Outbox / jobs (§6.3, §3.14) ────────────────────────────────────────────

/** Outbox poller tick (§6.3 — tunable). */
export const OUTBOX_POLLER_TICK_MS: number = 250;

/** Redis lease TTL for outbox-poller leader election (§6.3). */
export const OUTBOX_LEADER_LEASE_TTL_MS: number = 10 * SECOND_MS;

/** Projection-blocks debounce per doc (§3.6, §12). */
export const PROJECTION_BLOCKS_DEBOUNCE_MS: number = 250;

/** SQLite JobService declared ceiling — jobs/min sustained (ADR 0014, §3.14). */
export const SQLITE_JOBS_PER_MIN_CEILING: number = 100;

// ── Transact / write-path (§6.4) ───────────────────────────────────────────

/** Max retries on UNIQUE(doc_id, seq) conflict before surfacing ConflictError. */
export const WRITE_PATH_SEQ_RETRY_CAP: number = 3;

/** Phase 3 load-test assertion: observed retry count should stay below this. */
export const WRITE_PATH_SEQ_RETRY_ALERT: number = 5;

// ── Audit (§9.3) ───────────────────────────────────────────────────────────

/** Audit-writes sustained per-principal rate limit (§9.3, ADR 0009). */
export const AUDIT_WRITES_PER_MIN_SUSTAINED: number = 1_000;

/** Audit-writes burst cap; overflow window triggers circuit-break. */
export const AUDIT_WRITES_BURST_CAP: number = 3_000;

/** Sustained audit-write overflow window before principal suspension. */
export const AUDIT_OVERFLOW_SUSPEND_AFTER_MS: number = 5 * MINUTE_MS;

/** Read-collapse matching window (§9.3 — identical input collapse). */
export const AUDIT_READ_COLLAPSE_WINDOW_MS: number = 1 * SECOND_MS;

// ── Rate limits (Appendix A — agent/human defaults) ────────────────────────

/** Human PAT default daily request budget (ADR 0016 §Per-principal rate limits). */
export const HUMAN_PAT_REQ_PER_DAY_DEFAULT: number = 100_000;

/** Human PAT default daily write budget. */
export const HUMAN_PAT_WRITES_PER_DAY_DEFAULT: number = 10_000;

/** Agent API-key default daily request budget. */
export const AGENT_API_KEY_REQ_PER_DAY_DEFAULT: number = 50_000;

/** Agent API-key default daily write budget. */
export const AGENT_API_KEY_WRITES_PER_DAY_DEFAULT: number = 5_000;

// ── Webhooks (§3.17, §16.12) ───────────────────────────────────────────────

/** Webhook HTTP request timeout (§3.17). */
export const WEBHOOK_DELIVERY_TIMEOUT_MS: number = 10 * SECOND_MS;

/** Webhook delivery backoff ladder: 1s, 5s, 30s (§3.17). */
export const WEBHOOK_BACKOFF_LADDER_MS: readonly [number, number, number] = [
  1 * SECOND_MS,
  5 * SECOND_MS,
  30 * SECOND_MS,
];

/** Consecutive-failure count that trips the webhook circuit breaker (§3.17). */
export const WEBHOOK_CIRCUIT_BREAK_CONSECUTIVE_FAILS: number = 20;

/** HMAC timestamp skew window for webhook delivery verification (§16.12). */
export const WEBHOOK_SIGNATURE_SKEW_WINDOW_MS: number = 5 * MINUTE_MS;

// ── Search (§11.4, ADR 0008) ───────────────────────────────────────────────

/** SQLite brute-force search threshold — nag to migrate above this count. */
export const SQLITE_SEARCH_SOFT_CEILING: number = 500_000;

/** SQLite brute-force search hard refuse threshold for reembed. */
export const SQLITE_SEARCH_HARD_CEILING: number = 1_000_000;

/** Hybrid search RRF constant (§3.13 — both drivers must use identical k). */
export const RRF_K: number = 60;

/** Candidate-set multiplier before fusion (§11.2). */
export const SEARCH_CANDIDATE_MULTIPLIER: number = 3;

/** Atomic swap grace — old embedding index kept this long after flip (§11.3). */
export const EMBEDDING_SWAP_GRACE_MS: number = 24 * HOUR_MS;

/** nDCG@10 regression gate — drop > this many points blocks release (§17.3). */
export const NDCG_AT_10_REGRESSION_GATE: number = 2;

/** pgvector HNSW defaults (§3.13 / §11.4). Documented so operators don't guess. */
export const PGVECTOR_HNSW_M: number = 16;
export const PGVECTOR_HNSW_EF_CONSTRUCTION: number = 64;

// ── Disaster recovery (§18.1) ──────────────────────────────────────────────

/** Postgres-mode Recovery Point Objective (§18.1). */
export const RPO_POSTGRES_MS: number = 15 * MINUTE_MS;

/** SQLite-mode Recovery Point Objective (§18.1). */
export const RPO_SQLITE_MS: number = 24 * HOUR_MS;

/** Single-node Recovery Time Objective (§18.1). */
export const RTO_SINGLE_NODE_MS: number = 30 * MINUTE_MS;

/** HA Recovery Time Objective (§18.1). */
export const RTO_HA_MS: number = 2 * HOUR_MS;

/** Backup coordination window — DB + object store must snapshot within (§18.1 F84). */
export const BACKUP_COORDINATION_WINDOW_MS: number = 1 * MINUTE_MS;

/** EDITORZERO_DR_MODE auto-clear window (§18.1 F59). */
export const DR_MODE_AUTO_CLEAR_MS: number = 24 * HOUR_MS;

// ── Secrets (§16.12) ───────────────────────────────────────────────────────

/** Better Auth secret rotation cadence (ADR 0010). */
export const BETTER_AUTH_ROTATION_MS: number = 90 * DAY_MS;
