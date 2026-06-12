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

Most ADRs are **Accepted**. ADRs 0001–0020 were accepted (v2) at the Phase-2 boundary (2026-04-17); 0021–0026 landed as additive Phase-3 slices and are Accepted-and-implemented; **0027–0033 are the Web UI surface-architecture cluster (2026-05-30)**, which **superseded 0004 and 0005**; 0034–0035 refined the schemas SSOT + SPA scaffold; **0036–0039 are the Web UI surface-foundations cluster (2026-05-31)** — brand (Meridian Zero), design system + theming (Base UI), the owned Tiptap editor (superseding 0031), and the PWA/mobile/offline stance. **0040** is the tenancy & information-architecture model (Org → Space *hard-ceiling* → Collection/Doc per-doc ACL; Personal spaces; item-scoped guest grants; publish as an independent dimension; agents as peer grant-targets), which **extends 0024** and pins the access algebra (2026-06-01). The red-team and refresh trails are linked at the bottom.

| # | Title | Status |
|---|---|---|
| [0001](0001-license.md) | License: AGPL-3.0 with DCO | Accepted |
| [0002](0002-backend-runtime.md) | Backend runtime: Node 22 LTS with Hono | Accepted (v2) |
| [0003](0003-crdt-library.md) | CRDT library: Yjs with resource limits | Accepted |
| [0004](0004-rich-text-editor.md) | Rich-text editor: BlockNote | **Superseded by [0031](0031-editor-substrate.md) (2026-05-30)** |
| [0005](0005-ui-framework.md) | UI framework: Next.js 16 App Router | **Superseded by [0027](0027-web-ui-topology.md) (2026-05-30)** |
| [0006](0006-realtime-transport.md) | Real-time transport: Hocuspocus embedded | Accepted (v2) |
| [0007](0007-database-strategy.md) | Database: dual SQLite + Postgres, Kysely + Atlas CE | Accepted (v2) |
| [0008](0008-search.md) | Search: FTS5 + sqlite-vec / tsvector + pgvector, RRF, eval harness | Accepted (v2) |
| [0009](0009-mcp-sdk-and-capability-design.md) | MCP SDK and capability registry | Accepted (v2) |
| [0010](0010-sso.md) | Auth spine: Better Auth (core + sso + oauth-provider + mcp + api-key + agent-auth) | **Accepted (v2, scope expanded)** |
| [0011](0011-custom-domains-tls.md) | Custom domains and TLS: Caddy sidecar with allow-listed on-demand TLS | Accepted |
| [0012](0012-deploy-artifact.md) | Deploy artifact: docker-compose primary + Bun-compiled CLI | Accepted (v2) |
| [0013](0013-block-model.md) | **Block model: CRDT-as-source-of-truth with per-block-type Markdown fidelity** | **Accepted (v2, supersedes v1 Markdown-AST)** |
| [0014](0014-job-queue.md) | Job queue: pg-boss on Postgres, custom in-DB on SQLite | Accepted |
| [0015](0015-permission-enforcement.md) | Permission enforcement: capability-layer + tenant plugin (Postgres RLS **amended → not committed** by [0040](0040-tenancy-ia-model.md)) | Accepted (RLS layer + Layer-1 algebra amended by 0040) |
| [0016](0016-principal-model.md) | Principal model: humans and agents as peer types | Accepted (v2) |
| [0017](0017-soft-delete-recovery.md) | Soft-delete and recovery semantics | Accepted |
| [0018](0018-unified-write-path.md) | Unified write path via ServerBlockNoteEditor | Accepted (v2) |
| [0019](0019-observability.md) | Observability: OpenTelemetry + Prometheus + admin dashboard | Accepted |
| [0020](0020-git-mirror-export.md) | **Git-mirror export (opt-in) + S3-versioning archive** | **Accepted (new)** |
| [0021](0021-surface-transport-topology.md) | **Surface transport topology: Hono app as trunk, typed RPC for all surfaces** | **Accepted (new, 2026-04-18)** |
| [0022](0022-agent-editing-constraints.md) | **Agent-editing constraints on block capabilities** (precondition hash, reserved selectors, deferred ergonomic wrappers) | **Accepted (new, 2026-04-18)** |
| [0023](0023-postgres-driver-substrate.md) | **Postgres driver substrate: `pg` + testcontainers + dual-backend conformance** | **Accepted (new, 2026-04-19)** |
| [0024](0024-workspace-membership-shape.md) | **Workspace membership shape: custom `workspace_members` table; Better Auth for credentials only** | **Accepted (new, 2026-04-20)** |
| [0025](0025-cli-auth-bootstrap-credential-store.md) | **CLI auth bootstrap: email+password → session cookie (transitional); `AuthCredentialStore` seam; `/infra/whoami`** | **Accepted (new, 2026-04-20)** |
| [0026](0026-mcp-auth-bootstrap-session-cookie.md) | **MCP first-slice: transitional cookie auth + deliberately stateless** | **Accepted (new, 2026-04-20)** |
| [0027](0027-web-ui-topology.md) | **Web UI topology: Hono trunk as top-level server; Vite/React SPA; event-rendered static published docs** | **Accepted (new, 2026-05-30; supersedes 0005)** |
| [0028](0028-web-ui-routing-typed-client.md) | **Web UI routing: TanStack Router + the single typed-client seam** | **Accepted (new, 2026-05-30)** |
| [0029](0029-api-package-shape.md) | **API package shape: registry-generated per-route Hono factories under one tuple literal** | **Accepted (new, 2026-05-30; refines 0021)** |
| [0030](0030-better-auth-mount.md) | **Better Auth mounted in-trunk, same-origin, zero framework adapter** | **Accepted (new, 2026-05-30)** |
| [0031](0031-editor-substrate.md) | **Editor substrate: bootstrap on BlockNote, eject to Tiptap v3 + owned block layer (clean-start)** | **Superseded by [0038](0038-owned-editor-tiptap-direct.md) (2026-05-31); superseded 0004** |
| [0032](0032-version-history-track-changes.md) | **Version history + track-changes: build ourselves on Yjs snapshots + prosemirror-changeset** | **Accepted (new, 2026-05-30)** |
| [0033](0033-web-ui-testing-rpc-contract.md) | **Web UI testing strategy + typed RPC error contract** | **Accepted (new, 2026-05-30)** |
| [0034](0034-schemas-ssot-package.md) | **`@editorzero/schemas`: single-source wire+internal contracts reused by capabilities and surfaces** | **Accepted (new, 2026-05-30; refines 0029)** |
| [0035](0035-web-ui-spa-scaffold.md) | **Web UI SPA scaffold: `apps/app`, Vite same-origin dev proxy, file-based routing, exact-pin + lockfile + pnpm cooldown supply-chain posture** | **Accepted (new, 2026-05-31; editor pins amended by 0037/0038/0039)** |
| [0036](0036-brand-meridian-zero.md) | **Brand & visual identity: Meridian Zero (cold-Swiss; ultramarine + agent-cyan; AA-hardened token SSOT)** | **Accepted (new, 2026-05-31)** |
| [0037](0037-design-system-base-ui-theming.md) | **Design system & theming: Base UI shell + layered design tokens (curated + user-authored themes by `:root` override)** | **Accepted (new, 2026-05-31; retires the Mantine assumption)** |
| [0038](0038-owned-editor-tiptap-direct.md) | **Owned editor: adopt Tiptap v3 directly + DOM-free JSON-in server write path** | **Accepted (new, 2026-05-31; supersedes 0031)** |
| [0039](0039-pwa-mobile-offline.md) | **PWA, mobile & offline-CRDT stance: installable PWA, offline-read-only v1, responsive 3-pane collapse, iOS auth verdict** | **Accepted (new, 2026-05-31)** |
| [0040](0040-tenancy-ia-model.md) | **Tenancy & IA model: Org → Space (membership ceiling) → Collection/Doc (per-doc ACL); Personal spaces; item-scoped guest grants; publish as an independent dimension; agents as peer grant-targets** | **Accepted (new, 2026-06-01; extends 0024, amends 0015/0017/0020)** |
| [0041](0041-audited-genesis-bootstrap.md) | **Audited genesis bootstrap via system-audit provenance markers** | **Accepted (new, 2026-06-02; closes the invariant-3 genesis gap; relates 0024/0040)** |
| [0042](0042-trash-listing.md) | **Trash listing: `trash.list` — trash browse by per-kind acting-authority predicates; restorability stays with restore (`/trash` prefix; visible-stream cursor)** | **Proposed (draft 2026-06-12; cross-model Codex review folded same day; extends 0017, applies 0040's read postures; awaiting @numman)** |

## Review trails

- [`red-team-phase-1.md`](red-team-phase-1.md) — Phase 1 v1 red-team: 25 findings, 22 accepted, 3 partially accepted or rebutted with reasoning.
- [`red-team-phase-2.md`](red-team-phase-2.md) — Phase 2 pass-2: F31–F53 (all applied).
- [`red-team-phase-3.md`](red-team-phase-3.md) — Phase 2 pass-3 (cross-model Opus + Codex): F54–F84 (all applied).
- [`red-team-phase-4.md`](red-team-phase-4.md) — Phase 3 first pass against landed code (Codex): F85–F97 (3 BLOCKER, 4 HIGH, 1 MEDIUM, 1 LOW, 4 UNUSUAL-GOOD). All applied 2026-04-18.
- [`refresh-research-phase-1.md`](refresh-research-phase-1.md) — Phase 1 v2 refresh: 8 Opus sub-agent memos; substantive changes to ADRs 0002/0004/0005/0006/0007/0008/0009/0010/0012/0013/0016/0018; new ADR 0020.
- [`research-identity-resolution.md`](research-identity-resolution.md) — fact memo (2026-06-12, NOT an ADR) for the future identity-resolution ADR: the five-gap cluster blocking the member/permission/guest ui cells, the auth-read seam, the decided privacy bounds, the untaken forks.
- **Web UI surface-architecture review (2026-05-30)** — the 0027–0033 cluster: a 36-agent exhaustive Workflow review (`wf_b3e0aac1-bff`) with judge panels + 5 adversarial red-teamers, plus a cross-model Codex ADR-level pass (3 block-acceptance findings + 2 refinements, all integrated). Superseded 0004 (editor) and 0005 (UI framework); rewrote ADR 0012's server-artifact line and architecture.md §5.4.
- **Web UI surface-foundations cluster (2026-05-31)** — the 0036–0039 ADRs. Brand chosen via a divergent-generate-then-curate Workflow over 12 full-screen design explorations (`wf_b3a17378-0fb` design, `wf_545b3708-b04` buildout + a11y audit); Nomi selected **Meridian Zero**. A research + adversarial-verification Workflow (`wf_734a602e-3d6`, 7 agents) then verified every library pin against the live npm registry + official docs/specs (2026-05-31), **correcting** the design-system, editor, and PWA drafts before they locked: no `y-prosemirror@2.0.0` exists; Hocuspocus is at 4.1.0 (repo pins 3.4.4); `@base-ui/react@1.5.0` carries mandatory `date-fns`/`@date-fns/tz` peer-deps; Floating-UI convergence is at `@floating-ui/dom@1.7.6` via two adapters; the SW-cannot-touch-WS claim re-cited to the Fetch spec. Superseded 0031 (editor) and the Mantine-via-BlockNote assumption; amended 0018 (DOM-free write path) and 0035 (editor pins).
- **Tenancy & IA model review (2026-06-01)** — ADR 0040. Model B (Org → Space hard-ceiling → Collection/Doc per-doc ACL) approved by Nomi after a visual decision brief ([`docs/ia/tenancy-models.html`](../ia/tenancy-models.html)) grounded in three product research runs (Notion / Linear / cross-tool). The ADR + a roadmap-cohesive impact plan were produced by a 4-phase Workflow (`wf_d4d021be-118`, 15 agents): an **8-area corpus map** (permissions, schema, capability-parity, docs/visibility, web-ui, audit/jobs, roadmap, auth) → synthesis → draft → a **5-lens adversarial red-team** (invariant-integrity, migration-safety, permission-soundness, surface-parity, roadmap-scope). 2 blockers + 13 highs were folded into the final ADR before commit — the most consequential being that the enforcement machinery the model relies on (Postgres RLS, the audit-replay engine, the four-way contract-tests harness, the `acting_as` scope-intersection) is **specified-but-unbuilt today**, for the existing model as well; the ADR is honest about that and sequences each as a hard gate. Extends 0024; amends 0015/0017/0020 + architecture §3.12/§8.1/§9.1.
