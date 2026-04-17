# ADR 0008 — Search: FTS5 + sqlite-vec / tsvector + pgvector with RRF, eval harness, lazy embeddings

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Hybrid keyword + semantic search behind one API. Default self-host must not require a separate search daemon. Dual backends. Embedding model must be swappable so self-hosters can be fully offline.

Red-team flagged two issues: #17 RRF k=60 without an eval harness is a silent relevance cliff; #18 bge-small ONNX has a cold-start + RAM cost we must size honestly.

## Options considered
- **SQLite: FTS5 (native BM25) + sqlite-vec** (pure C, zero deps, MIT/Apache-2).
- **Postgres: tsvector + pgvector** (HNSW). `ts_rank` is not BM25.
- **Postgres upgrade: ParadeDB `pg_search`** — Tantivy BM25 as a native index; AGPL-3.0. Opt-in.
- **Separate server (Meilisearch / Typesense / Qdrant)** — violates "no extra daemon" default.

## Decision
- **SQLite mode:** FTS5 + sqlite-vec, in-process, zero extra deps.
- **Postgres mode:** tsvector + pgvector by default; `pg_search` as an opt-in config flag for users who want BM25.
- **Embedding model:** default **local ONNX `bge-small-en-v1.5`** (~130 MB on disk, ~200 MB RAM loaded). Admin-configurable to OpenAI `text-embedding-3-small`, Voyage, Cohere, or any OpenAI-compatible endpoint.
- **Hybrid fusion:** Reciprocal Rank Fusion, `k=60`, applied in the application layer. Same code for both backends.
- **API:** `SearchService` interface with `query({ workspace_id, q, filters, limit })` returning `{ doc_id, score, snippets }`; drivers expose `bm25Candidates` and `vectorCandidates`; fusion is shared.

### Eval harness (red-team #17) — Phase 3 deliverable

Held-out test set: ~200 queries with judged-relevant docs (manual + synthetic). Measured per-mode and hybrid:
- **nDCG@10** (primary)
- **recall@50** (secondary, catches ANN index regressions)
- **MRR** (tertiary, query-difficulty signal)

Runs in CI on corpus fixture (seeded 10k blocks). A new PR that regresses nDCG@10 by > 2 points on any mode is blocked. Production deployments run the eval on live seeded content daily and alert on regression.

### Embedding runtime (red-team #18)

- **Lazy-load:** ONNX runtime + model not loaded until first `embed()` call. Instances that never run semantic search have zero embedding RAM cost.
- **Per-instance singleton:** one ONNX session per process, shared across requests.
- **Memory floors (documented):** keyword-only ≈ 50 MB, with embeddings (bge-small loaded) ≈ +200 MB. Installer prints both.
- **Language note:** bge-small is English-biased. Non-English tenants get degraded semantic search; documented in the operator runbook. Pluggable embedder means a tenant-admin can switch to a multilingual model (e.g., `bge-m3`) per workspace.
- **Dimension migration:** changing the embedding model is an explicit reindex operation (job via ADR 0014); old vectors are not silently mixed with new.

## Consequences
- Single-host default has zero extra deps; zero mandatory RAM beyond keyword search.
- Relevance parity is measured, not assumed; regressions are caught.
- Semantic search is opt-in from a memory perspective — operators can run keyword-only without paying the RAM tax.
- Multilingual quality gap is documented and configurable.

## Revisit triggers
- sqlite-vec hits stability issues at target corpus sizes.
- Relevance gap between SQLite and Postgres-default produces user-visible complaints → promote ParadeDB from opt-in to default on Postgres.
- Eval harness reveals a fusion tuning regime that beats RRF k=60 on our corpus → switch to Weighted RRF.
- A single in-DB combined BM25+vector solution matures (e.g., `pg_search` gains a first-class vector column).
