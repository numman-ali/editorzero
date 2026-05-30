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
