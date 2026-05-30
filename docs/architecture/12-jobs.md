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
