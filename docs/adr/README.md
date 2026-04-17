# Architectural Decision Records

One file per decision. Format: `NNNN-kebab-case-slug.md`, numbered in order of acceptance.

## Template

```markdown
# ADR NNNN — Short title

**Status:** Proposed | Accepted | Superseded by NNNN | Rejected
**Date:** YYYY-MM-DD
**Deciders:** @handle, @handle

## Context
What problem are we solving? What constraints apply? What research informs this?

## Options considered
### Option A — name
Summary. Pros. Cons. Links / citations.

## Decision
Chosen option. Why.

## Consequences
What becomes easier. What becomes harder.

## Revisit triggers
- Concrete conditions that would cause us to reopen this decision.
```

## Index

All ADRs are **Accepted (v2, post-refresh)** as of 2026-04-17 unless noted. The red-team and refresh trails are linked at the bottom.

| # | Title | Status |
|---|---|---|
| [0001](0001-license.md) | License: AGPL-3.0 with DCO | Accepted |
| [0002](0002-backend-runtime.md) | Backend runtime: Node 22 LTS with Hono | Accepted (v2) |
| [0003](0003-crdt-library.md) | CRDT library: Yjs with resource limits | Accepted |
| [0004](0004-rich-text-editor.md) | Rich-text editor: BlockNote | **Accepted (v2, supersedes v1 Milkdown)** |
| [0005](0005-ui-framework.md) | UI framework: Next.js 16 App Router | Accepted (v2) |
| [0006](0006-realtime-transport.md) | Real-time transport: Hocuspocus embedded | Accepted (v2) |
| [0007](0007-database-strategy.md) | Database: dual SQLite + Postgres, Kysely + Atlas CE | Accepted (v2) |
| [0008](0008-search.md) | Search: FTS5 + sqlite-vec / tsvector + pgvector, RRF, eval harness | Accepted (v2) |
| [0009](0009-mcp-sdk-and-capability-design.md) | MCP SDK and capability registry | Accepted (v2) |
| [0010](0010-sso.md) | Auth spine: Better Auth (core + sso + oauth-provider + mcp + api-key + agent-auth) | **Accepted (v2, scope expanded)** |
| [0011](0011-custom-domains-tls.md) | Custom domains and TLS: Caddy sidecar with allow-listed on-demand TLS | Accepted |
| [0012](0012-deploy-artifact.md) | Deploy artifact: docker-compose primary + Bun-compiled CLI | Accepted (v2) |
| [0013](0013-block-model.md) | **Block model: CRDT-as-source-of-truth with per-block-type Markdown fidelity** | **Accepted (v2, supersedes v1 Markdown-AST)** |
| [0014](0014-job-queue.md) | Job queue: pg-boss on Postgres, custom in-DB on SQLite | Accepted |
| [0015](0015-permission-enforcement.md) | Permission enforcement: capability-layer + Postgres RLS | Accepted |
| [0016](0016-principal-model.md) | Principal model: humans and agents as peer types | Accepted (v2) |
| [0017](0017-soft-delete-recovery.md) | Soft-delete and recovery semantics | Accepted |
| [0018](0018-unified-write-path.md) | Unified write path via ServerBlockNoteEditor | Accepted (v2) |
| [0019](0019-observability.md) | Observability: OpenTelemetry + Prometheus + admin dashboard | Accepted |
| [0020](0020-git-mirror-export.md) | **Git-mirror export (opt-in) + S3-versioning archive** | **Accepted (new)** |

## Review trails

- [`red-team-phase-1.md`](red-team-phase-1.md) — Phase 1 v1 red-team: 25 findings, 22 accepted, 3 partially accepted or rebutted with reasoning.
- [`refresh-research-phase-1.md`](refresh-research-phase-1.md) — Phase 1 v2 refresh: 8 Opus sub-agent memos; substantive changes to ADRs 0002/0004/0005/0006/0007/0008/0009/0010/0012/0013/0016/0018; new ADR 0020.
