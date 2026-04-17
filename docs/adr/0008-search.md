# ADR 0008 — Search: FTS5 + sqlite-vec (brute-force primary) / tsvector + pgvector + RRF + eval harness

**Status:** Accepted (post-refresh)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

## Context
Hybrid keyword + semantic search behind one API. Default self-host must not require a separate search daemon. Dual backends. Embedding model must be swappable for offline self-hosters.

Refresh material updates:
- **sqlite-vec v0.1.9** (March 31 2026). **ANN (DiskANN / IVF) is still alpha** per [issue #25](https://github.com/asg017/sqlite-vec/issues/25). Brute-force path is production-safe for **< ~1M vectors**; ANN should not back production recall SLAs yet.
- **pgvector v0.8.2** (Feb 26 2026) — fixes **CVE-2026-3172** (parallel HNSW build buffer overflow). **Pin >= 0.8.2 urgently.** Iterative index scans (`hnsw.iterative_scan`, `hnsw.max_scan_tuples`) from 0.8.0 help over-filtered queries. Postgres 18 is supported.

## Decision
- **SQLite mode:** FTS5 + sqlite-vec, in-process, zero extra deps. **Brute-force vector search** is the production path; corpus ceiling ~1M vectors (aligned with the SQLite-mode envelope in ADR 0007). An **experimental ANN track** runs behind `EDITORZERO_SQLITE_VEC_ANN=experimental` for early-adopters; not default.
- **Postgres mode:** **pgvector >= 0.8.2** (HNSW default, IVFFlat batch) + tsvector. **ParadeDB `pg_search`** (AGPL, Tantivy BM25) as opt-in for users who want BM25 relevance.
- **Embedding model:** default **local ONNX `bge-small-en-v1.5`** (~130 MB on disk, ~200 MB RAM loaded, lazy-loaded on first `embed()` call). Admin-configurable to OpenAI `text-embedding-3-small`, Voyage, Cohere, or any OpenAI-compatible endpoint.
- **Hybrid fusion:** Reciprocal Rank Fusion, `k=60`, applied application-side. Same implementation across both backends so ranking is identical given identical candidate sets.
- **API:** `SearchService` interface with `query({ workspace_id, q, filters, limit })` returning `{ doc_id, score, snippets }`; drivers expose `bm25Candidates` and `vectorCandidates`; fusion shared.

### Eval harness (Phase 3 deliverable)
Held-out ~200 queries with judged-relevant docs. Measured per-mode and hybrid: **nDCG@10** (primary), **recall@50** (ANN regression detector), **MRR** (query-difficulty signal). Runs on corpus fixture (10k blocks) in CI; PRs that regress nDCG@10 by > 2 points are blocked. Production runs daily against seeded live content; regression alerts page.

### Embedding runtime honesty
- **Lazy-load:** instances without semantic search pay zero embedding RAM.
- **Per-instance singleton:** one ONNX session per process.
- **Memory floors (documented):** keyword-only ≈ 50 MB; with embeddings loaded ≈ +200 MB. Installer prints both.
- **Language note:** bge-small is English-biased; non-English tenants get degraded semantic search by default. Pluggable embedder means admin can swap to `bge-m3` or similar multilingual per workspace.
- **Dimension migration:** changing the embedding model is an explicit reindex job (ADR 0014 queue); old vectors are never silently mixed with new.

## Consequences
- Single-host default has zero extra deps and zero mandatory embedding RAM.
- Relevance parity measured, not assumed.
- SQLite-mode vector search is honest: brute force works to ~1M; ANN is experimental. This aligns with the ADR 0007 declared ceiling.
- Postgres-mode pgvector CVE is patched via version pin.
- Multilingual gap is documented and configurable.

## Revisit triggers
- sqlite-vec ANN (DiskANN / IVF) hits stable and matches pgvector HNSW recall on our corpus.
- The relevance gap between SQLite (FTS5 BM25) and Postgres (`ts_rank`, not BM25) produces user-visible complaints at scale → promote `pg_search` to Postgres-mode default.
- Eval harness reveals a fusion regime beating RRF k=60 → switch to Weighted RRF or learned fusion.
- A single in-DB solution (e.g., `pg_search` adds first-class vector type) removes the need for pgvector as a separate extension.
