# Continuation — rolling work state

*This file is the rolling work-state journal. AGENTS.md is canonical and durable; this file is what an agent updates as work progresses. Edit freely; commit with each phase-boundary update.*

---

## Current phase

**Phase 1 complete (v2 post-refresh). Phase 2 (architecture) pending a go-ahead from @numman or a compaction checkpoint.**

## Immediate focus

Produce `docs/architecture.md` synthesizing ADRs 0001–0020 into a system design:
- Data model (polymorphic principals, workspaces, docs, blocks, versions, audit, comments, attachments, CRDT state, search indexes, job queue, git-mirror metadata).
- Capability matrix — every capability, its `requires` permissions, its `input`/`output` schemas, its rate-limit profile.
- Four-surface adapter generation pattern (API handlers, CLI commands, MCP tools, Web UI Server Actions from the registry).
- Permission model worked examples (cross-workspace read, public publish, agent-only tokens, `acting_as` delegation).
- Event / audit model.
- OpenAPI contract (draft).
- MCP capability surface (draft).
- Verification strategy wiring each invariant to the property/contract/integration/e2e test that proves it.

## Resume protocol (for a fresh-context agent)

1. **Read this file first** — current phase, immediate focus, open questions.
2. Read `AGENTS.md` — canonical working rules + invariants.
3. Read `docs/brief.md` — Phase 0 framing.
4. Read `docs/adr/README.md` — ADR index.
5. Skim `docs/adr/red-team-phase-1.md` + `docs/adr/refresh-research-phase-1.md` for the reasoning trail behind the stack (why we landed here, not just what we landed on).
6. `git log --oneline -20` — work-in-progress head.
7. `TaskList` — current-session tasks.
8. **Do not read all 20 ADRs front-to-back unless necessary.** Read only those relevant to the immediate focus.
9. If any "Open questions" below would block the next action, raise them before acting.

## Open questions for @numman

1. **Scale target** (carried from `docs/brief.md`): 10 users/instance, or 10k users/instance? Shapes whether we invest in horizontal Hocuspocus scaling and whether SQLite mode stays viable end-to-end.
2. **Sub-block ACLs** (carried from `docs/brief.md`): does permission resolution need to go below block granularity?
3. **Commercial arm** (carried from `docs/brief.md`): OSS-only or OSS + hosted? AGPL-3.0 + DCO (ADR 0001) does not pre-commit the answer; other decisions might if we ever want a paid tier.

None of these block Phase 2 architecture; propose defaults in the architecture doc and let @numman override there.

## Recent history

- **2026-04-17:** Phase 0 scaffolded → Phase 1 v1 ADRs (12 → 19, after first red-team pass) → Phase 1 v2 ADRs (post-refresh; BlockNote replaces Milkdown, Better Auth consolidation, Next 16.2, block-model rewrite, new git-mirror ADR 0020). Public repo created at https://github.com/numman-ali/editorzero. Workflow confirmed: direct-to-main, pre-commit hooks, no PRs needed.

## Signals to check when resuming

- If `docs/architecture.md` exists and has content → Phase 2 is underway.
- If `package.json` / monorepo tooling exists → Phase 3 harness is underway.
- If route handlers / capability implementations exist → Phase 4 slices are underway.
- If security pass / load tests / runbook artifacts exist → Phase 5.

## Update protocol for future me

- At every phase boundary: update the "Current phase," "Immediate focus," and "Recent history" sections; commit with a message like `continuation: close Phase N, open Phase N+1`.
- Mid-phase, if context is about to be compacted and important nuance is at risk of loss, flush a short note to the "Recent history" section so it's visible on next load.
- When an "Open question" is answered, strike it through (do not delete — the record is useful) and add a note about what the answer was.
