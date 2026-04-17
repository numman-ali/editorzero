# AGENTS.md

Conventions and invariants for agents (human or AI) working in this codebase.

## What this project is
Open-source, self-hostable, AI-native documentation and collaboration platform.
Humans and AI agents are peer co-editors. API + CLI + MCP + Web UI at full functional parity.

See `docs/brief.md` for framing, invariants, and assumptions.

## Where to look
- `docs/brief.md` — project framing, reframings, invariants, open questions
- `docs/adr/NNNN-*.md` — one file per architectural decision
- `docs/architecture.md` — system design (populated in Phase 2)
- `docs/runbook.md` — operator playbook (populated by Phase 4)
- `docs/threat-model.md` — security posture (populated by Phase 5)
- `CHANGELOG.md` — per-release notes

## Hard invariants (do not break)
Enumerated in `docs/brief.md` § Hard invariants. Property tests enforce them (Phase 3+).

## Verification stack — what "done" means

Every change must pass, in order:

1. **Types** — `tsc --noEmit` clean across the monorepo.
2. **Lint + format** — zero warnings.
3. **Unit tests** — pure logic.
4. **Property tests** — CRDT convergence, Markdown round-trip fixed-point (ADR 0013), inverse-restore (ADR 0017), permission invariants.
5. **Integration tests** — capabilities against a real SQLite and a real Postgres (ADR 0007 conformance suite).
6. **Contract tests** — API/CLI/MCP/UI parity matrix, generated from the capability registry (ADR 0009, 0015).
7. **E2E tests** — Playwright, including `@axe-core/playwright` for WCAG 2.1 AA coverage (red-team #22).
8. **Smoke deploy** — ephemeral compose env spins up, hits `/health`, creates a doc, tears down.
9. **Observability check** — traces export, no unexpected error spans (ADR 0019).

A PR that fails any step is red; "fix it in the next commit" is not acceptable.

## Working rules

1. **No feature code without an ADR.** No ADR without alternatives considered.
2. **Verification stack is non-negotiable.** Every change must pass, in order:
   types → lint → unit → property → integration → contract → e2e → smoke deploy → observability check.
   Red = stop and fix. "Will address next commit" is not acceptable.
3. **Branch per slice. PR references ADRs.** Each PR carries test evidence.
4. **Agents are users.** Every human-facing control (auth, audit, undo, rate limit, attribution)
   has an agent equivalent. Review any design that treats them differently.
5. **Determinism is a feature.** Same Markdown in must produce same rendered output across API/CLI/MCP/UI.
   If you touch the doc model or any surface, run the round-trip property tests.
6. **Contract tests enforce surface parity.** Do not add a capability on one surface without
   adding it on every type-compatible surface. Generate adapters from the capability schema
   where possible.
7. **Terse, honest commits.** Imperative mood. Context + decision + consequences. No filler.
8. **Self-critique before phase transitions.** Spawn a red-team subagent with the plan/diff;
   treat findings as blocking until fixed or explicitly rejected with reasoning.

## Gotchas
(Populated as we discover them. Empty during Phase 0.)

## When in doubt
Ask Nomi. But only if the decision has lasting architectural consequences,
the requirement is genuinely ambiguous, or there is a hard external blocker.
Research, ADRs, refactors, subagents, backing out bad decisions — those are the agent's job.
