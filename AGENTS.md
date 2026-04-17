# AGENTS.md

You are reading `AGENTS.md` (symlinked as `CLAUDE.md`). This file is **auto-loaded into your context on every session** — it is the durable anchor. Treat it as canonical working practices, invariants, verification stack, gotchas. Update it only when a working practice genuinely changes.

**Your next read is [`docs/continuation.md`](docs/continuation.md)** — the rolling work state: current phase, immediate focus, open questions, resume protocol. Time-varying information lives there so this file can stay stable.

---

## What this project is

Open-source, self-hostable, AI-native documentation and collaboration platform. Humans and AI agents are peer co-editors. API + CLI + MCP + Web UI at full functional parity.

**Public repo:** https://github.com/numman-ali/editorzero

See [`docs/brief.md`](docs/brief.md) for framing, invariants, and assumptions. Architectural decisions live in [`docs/adr/`](docs/adr/).

## Where to look

| File | What it holds |
|---|---|
| [`docs/continuation.md`](docs/continuation.md) | **Rolling work state. Read first.** Current phase, immediate focus, open questions, resume protocol. |
| [`docs/brief.md`](docs/brief.md) | Phase 0 framing — reframings, hard invariants, open questions carried forward. |
| [`docs/adr/README.md`](docs/adr/README.md) | ADR index + review trails. |
| [`docs/adr/NNNN-*.md`](docs/adr/) | One file per architectural decision. |
| [`docs/architecture.md`](docs/architecture.md) | System design (Phase 2 output). |
| `docs/runbook.md` | Operator playbook (Phase 4 output — not yet created). |
| `docs/threat-model.md` | Security posture (Phase 5 output — not yet created). |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-release notes. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | External-contributor onboarding, DCO instructions. |

## Hard invariants (do not break)

Enumerated in [`docs/brief.md`](docs/brief.md) § Hard invariants. Property tests enforce them (Phase 3+):

1. Per-block-type Markdown fidelity round-trips cleanly under its declared tier (ADR 0013).
2. Any mix of concurrent human/agent edits converges across replicas via the CRDT.
3. Every mutation produces exactly one audit entry; the audit log alone can reconstruct final state.
4. Every capability exists on every surface it is type-compatible with (API/CLI/MCP/Web UI) — parity is enforced, not aspired to (ADR 0009/0015).
5. No mutation or tenant-scoped read is reachable without a permission check; no surface re-implements permission logic (ADR 0015).
6. Soft-deletes are recoverable via a first-class capability (ADR 0017).
7. **Content mutations** flow through the CRDT via a single write path — capability handlers receive `ctx.transact(doc_id, fn)` and never touch Hocuspocus, Y.Doc, or content-mirror DB tables directly. **Metadata mutations** (`block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.move`, `collection.*`) are dispatcher-tx-only and enumerated explicitly (ADR 0018). `doc.rename` is a **content** mutation — it edits the title block via `ctx.transact` — and is not in the metadata-only set (F54).
8. Agents are first-class principals with distinct rate limits, audit attribution, and revocation (ADR 0016).

## Verification stack — what "done" means

Every change must pass, in order. All gates run locally via **pre-commit hooks**; there is no separate CI bottleneck at this phase (the solo-author + agent flow doesn't need one).

1. **Types** — `tsc --noEmit` clean across the monorepo.
2. **Lint + format** — zero warnings (Biome).
3. **Unit tests** — pure logic.
4. **Property tests** — CRDT convergence, per-block Markdown fidelity (ADR 0013), inverse-restore (ADR 0017), permission invariants, capability-matrix parity.
5. **Integration tests** — capabilities against real SQLite **and** real Postgres (ADR 0007 conformance suite, covering the Atlas Pro analyzers we don't pay for).
6. **Contract tests** — API/CLI/MCP/UI parity matrix, generated from the capability registry.
7. **E2E tests** — Playwright, including `@axe-core/playwright` for WCAG 2.1 AA coverage.
8. **Smoke deploy** — ephemeral `docker compose` env, hit `/health`, create a doc, tear down.
9. **Observability check** — traces export, no unexpected error spans (ADR 0019).

A commit that fails any step is blocked at the hook. "Fix it in the next commit" is not acceptable; the hook doesn't let it land.

Steps 3–9 activate as Phase 3 lands the test harness and the first slice. Until then, only steps 1–2 are gateable.

If a hook is slow enough to cause friction, split it — a fast pre-commit (types + lint + affected unit tests) and a slower pre-push (property + integration + contract + e2e + smoke) is the standard pattern.

## Git workflow

- **Direct push to `main`.** Solo author + AI agent; no PR flow required. (If/when multiple humans contribute, switch to PRs and revise this section.)
- **DCO sign-off on every commit.** `git commit -s` enforces it; pre-commit hook can verify.
- **Commits are terse and imperative.** Context + decision + consequence. No filler. Imperative mood subject line, body for the "why."
- **Never force-push `main`.** Rewrite history in feature branches if needed before they exist.
- **Co-Authored-By footer** for AI-assisted commits:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

## Working rules

1. **No feature code without an ADR.** No ADR without alternatives considered.
2. **Agents are users.** Every human-facing control has an agent equivalent. Review any design that treats them differently.
3. **Determinism is a feature.** Doc-model changes must preserve CRDT convergence and per-block Markdown fidelity (ADR 0013). Property tests enforce this from Phase 3 onward; pre-harness, reason about it explicitly in the ADR.
4. **Contract tests enforce surface parity.** Do not add a capability on one surface without adding it on every type-compatible surface. Generate adapters from the capability registry where possible.
5. **Self-critique at phase transitions.** Spawn a red-team subagent with the plan/diff; treat findings as blocking until fixed or rebutted in writing (see `docs/adr/red-team-*.md`).
6. **Stop at phase boundaries.** At the end of each phase, update `docs/continuation.md`, commit, push, and post a summary to @numman for review before proceeding.
7. **Opus sub-agents only** (per @numman, 2026-04-17).
8. **Verify library/tool docs at point of use.** Before writing code against any pinned dependency (Hocuspocus, BlockNote, Better Auth, Yjs, Kysely, Atlas, MCP SDK, Next.js, Hono, etc.), fetch the current docs for the pinned version and confirm the API shape. Pinned versions drift; the gotchas list is populated by doing exactly this. If docs contradict an ADR, flag it in `docs/continuation.md` before coding around it.

## Gotchas

Maintained as we discover them.

### Runtime / APIs
- **Hocuspocus 3.4.x:** `onStoreDocument` is non-concurrent per doc; handler must be idempotent. `beforeSync` is no longer awaited; enforce resource limits in `onChange`.
- **BlockNote server-side writes:** `@blocknote/server-util`'s `ServerBlockNoteEditor` is a conversion surface — it has **no `transact()` method**. For mutations, open a Hocuspocus direct connection and call `editor.transact()` on a `BlockNoteEditor.create({ collaboration: { fragment } })` bound to the live Y.XmlFragment (ADR 0018). `blocksToYDoc` is explicitly **not a rehydration path** — it loses history.
- **Next.js 16 `"use cache"`:** cached functions cannot call `cookies()`/`headers()`/`searchParams`. Design cached functions to receive request context as arguments.
- **Better Auth `getServerSession`:** cannot be called inside a `"use cache"` scope.
- **Secrets:** never read credentials via `process.env` directly. All secret loads go through `packages/config/secrets.ts` so the source (`file | env | vault`) is typed and rotation hooks land in one place (architecture.md §16.12).

### Pinned versions (do not bump blind)
- **Atlas `migrate lint`:** moved to Pro in v0.38 (Oct 2025). Pin Atlas CE; cover missing analyzers in the conformance test suite.
- **sqlite-vec:** ANN is alpha as of v0.1.9. SQLite-mode vector search uses brute force (safe < 1M vectors); ANN is behind an experimental flag.
- **pgvector:** pin >= 0.8.2 (CVE-2026-3172 — parallel HNSW buffer overflow).
- **MCP SDK:** pin latest 1.x stable (v2.0.0-alpha.2 is alpha).
- **Node 22 LTS:** EOL April 30 **2027**. Plan Node 24 migration in Q3 2026.

## Available skills (Claude Code)

- **`dev-browser:dev-browser`** — browser automation with persistent page state. Use for UI verification, pixel-perfect checks against design, filling forms, taking screenshots, scraping, testing the web app. Trigger when you need to visually confirm UI work.

## When in doubt

Ask @numman. But only if the decision has lasting architectural consequences, the requirement is genuinely ambiguous, or there is a hard external blocker. Research, ADRs, refactors, subagents, backing out bad decisions — those are the agent's job.
