# Architecture — Phase 2 synthesis

**Status:** Draft (pre-red-team)
**Date:** 2026-04-17
**Inputs (Phase-2 snapshot):** ADRs 0001–0020 — later decisions 0021–0026 land as additive Phase-3 slices, cited inline. [`docs/brief.md`](../brief.md), red-team + refresh trails.
**Reader:** someone who has read [`AGENTS.md`](../../AGENTS.md) and [`docs/brief.md`](../brief.md) — this file does **not** re-argue decisions; rationale lives in the ADRs.

---

## Sections

This is the canonical Phase-2 architecture spec, split into one file per top-level section so it stays maintainable and friendly to workflow-driven build agents. Section **numbers are stable** across the split, so `§N.M` citations elsewhere (ADRs, `AGENTS.md`, source comments) still resolve.

| # | Section | File |
|---|---|---|
| 1 | Purpose | [01-purpose.md](01-purpose.md) |
| 2 | System at a glance | [02-system-at-a-glance.md](02-system-at-a-glance.md) |
| 3 | Data model | [03-data-model.md](03-data-model.md) |
| 4 | Capability registry | [04-capability-registry.md](04-capability-registry.md) |
| 5 | Four-surface adapters | [05-four-surface-adapters.md](05-four-surface-adapters.md) |
| 6 | Unified write path (ADR 0018) | [06-unified-write-path.md](06-unified-write-path.md) |
| 7 | Read path / projections | [07-read-path-projections.md](07-read-path-projections.md) |
| 8 | Permission model | [08-permission-model.md](08-permission-model.md) |
| 9 | Audit and attribution | [09-audit-and-attribution.md](09-audit-and-attribution.md) |
| 10 | Real-time / collab | [10-real-time-collab.md](10-real-time-collab.md) |
| 11 | Search | [11-search.md](11-search.md) |
| 12 | Jobs | [12-jobs.md](12-jobs.md) |
| 13 | Mirror (git + S3) | [13-mirror.md](13-mirror.md) |
| 14 | OpenAPI surface (derived, not authored) | [14-openapi-surface.md](14-openapi-surface.md) |
| 15 | MCP capability surface (draft) | [15-mcp-capability-surface.md](15-mcp-capability-surface.md) |
| 16 | Engineering primitives for agentic workflows | [16-engineering-primitives-for-agentic-workflows.md](16-engineering-primitives-for-agentic-workflows.md) |
| 17 | Verification strategy | [17-verification-strategy.md](17-verification-strategy.md) |
| 18 | Deployment topology | [18-deployment-topology.md](18-deployment-topology.md) |
| 19 | Open questions (carried into Phase 3) | [19-open-questions.md](19-open-questions.md) |
| A | Capability matrix | [appendix-a-capability-matrix.md](appendix-a-capability-matrix.md) |
| B | Subsystem responsibility map | [appendix-b-subsystem-responsibility-map.md](appendix-b-subsystem-responsibility-map.md) |
| C | Phase 3 entry checklist | [appendix-c-phase-3-entry-checklist.md](appendix-c-phase-3-entry-checklist.md) |
