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
