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

### Option B — name
Summary. Pros. Cons. Links / citations.

## Decision
Chosen option. Why.

## Consequences
What becomes easier. What becomes harder.

## Revisit triggers
- Concrete conditions that would cause us to reopen this decision.
```

## Index

All ADRs below are **Accepted (post-red-team)** as of 2026-04-17. The red-team disposition is in [`red-team-phase-1.md`](red-team-phase-1.md).

| # | Title | Status |
|---|---|---|
| [0001](0001-license.md) | License: AGPL-3.0 with DCO | Accepted |
| [0002](0002-backend-runtime.md) | Backend runtime: Node 22 LTS with Hono | Accepted |
| [0003](0003-crdt-library.md) | CRDT library: Yjs with resource limits | Accepted |
| [0004](0004-rich-text-editor.md) | Rich-text editor: Milkdown | Accepted |
| [0005](0005-ui-framework.md) | UI framework: Next.js 15 App Router | Accepted |
| [0006](0006-realtime-transport.md) | Real-time transport: Hocuspocus embedded | Accepted |
| [0007](0007-database-strategy.md) | Database: SQLite + Postgres, Kysely + Atlas | Accepted |
| [0008](0008-search.md) | Search: FTS5 + sqlite-vec / tsvector + pgvector, RRF, eval harness | Accepted |
| [0009](0009-mcp-sdk-and-capability-design.md) | MCP SDK and capability registry | Accepted |
| [0010](0010-sso.md) | SSO: Better Auth + @better-auth/sso | Accepted |
| [0011](0011-custom-domains-tls.md) | Custom domains and TLS: Caddy sidecar with allow-listed on-demand TLS | Accepted |
| [0012](0012-deploy-artifact.md) | Deploy artifact: docker-compose, full stop | Accepted |
| [0013](0013-block-model.md) | Block model: Markdown AST as source of truth | Accepted |
| [0014](0014-job-queue.md) | Job queue: pg-boss on Postgres, custom in-DB on SQLite | Accepted |
| [0015](0015-permission-enforcement.md) | Permission enforcement: capability-layer + Postgres RLS | Accepted |
| [0016](0016-principal-model.md) | Principal model: humans and agents as peer types | Accepted |
| [0017](0017-soft-delete-recovery.md) | Soft-delete and recovery semantics | Accepted |
| [0018](0018-unified-write-path.md) | Unified write path: all mutations flow through the CRDT | Accepted |
| [0019](0019-observability.md) | Observability: OpenTelemetry + Prometheus + admin dashboard | Accepted |

## Red-team trail

- [`red-team-phase-1.md`](red-team-phase-1.md) — 25 findings, disposition per finding, ADR mapping.
