# Continuation — rolling work state

*Rolling work-state journal. `AGENTS.md` (= `CLAUDE.md`) is already in your context — it is auto-loaded on every session. This file is what an agent updates as work progresses; commit with each phase-boundary update.*

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

1. **`AGENTS.md` is already loaded** via the CLAUDE.md symlink — canonical rules + invariants + gotchas are in your context.
2. **This file is your next read** — current phase, immediate focus, open questions (below).
3. Read `docs/brief.md` — Phase 0 framing.
4. Read `docs/adr/README.md` — ADR index.
5. Skim `docs/adr/red-team-phase-1.md` + `docs/adr/refresh-research-phase-1.md` for the reasoning trail behind the stack (why we landed here, not just what).
6. `git log --oneline -20` — work-in-progress head.
7. `TaskList` — current-session tasks.
8. **Do not read all 20 ADRs front-to-back unless necessary.** Read only those relevant to the immediate focus.
9. If any "Open questions" below would block the next action, raise them before acting.

## Open questions for @numman

1. ~~**Scale target:** 10 or 10k users/instance?~~ **Resolved 2026-04-17.** Production target is **500–1,000 minimum, with design headroom for 10,000**. Postgres mode is the production target; SQLite mode is for small-team pilots / dev / home-lab and keeps its declared envelope. Folded into [ADR 0007](adr/0007-database-strategy.md).
2. ~~**Sub-block ACLs:** does permission resolution go below block granularity?~~ **Resolved 2026-04-17.** Defer to a later release; reserve `AccessPath.selector` in the permission model so sub-block granularity is a clean additive change, not a rewrite. Folded into [ADR 0015](adr/0015-permission-enforcement.md).
3. **Commercial arm** (carried from `docs/brief.md`): OSS-only or OSS + hosted? AGPL-3.0 + DCO (ADR 0001) does not pre-commit the answer; other decisions might if we ever want a paid tier. **Still open; does not block Phase 2.**
4. **Agent offline-edit** (carried from `docs/brief.md`): do agents get offline/reconcile semantics or are they assumed always-online? Default "always-online" stands unless challenged. **Still open; does not block Phase 2.**

Nothing open blocks Phase 2 architecture. Propose defaults for (3) and (4) in the architecture doc and let @numman override there.

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
