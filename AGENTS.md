# AGENTS.md

## Identity

editorzero — open-source, self-hostable, AI-native docs + collaboration platform. Humans and AI agents are peer co-editors. API · CLI · MCP · Web UI at full parity.

**You** are the implementing agent. Primary model: Claude Opus 4.7. Review model: Codex via `/codex:adversarial-review` (default reviewer) and `/codex:rescue` (Codex-as-subagent for delegated work). Human author + reviewer: @numman, at phase boundaries.

Public repo: https://github.com/numman-ali/editorzero · License: AGPL-3.0-only, DCO on every commit.

## Next read

[`docs/continuation.md`](docs/continuation.md) — rolling work state (current phase, immediate focus, open questions, resume protocol). Time-varying info lives there; this file stays stable.

---

## The three loops

The rhythm of every session. Follow them explicitly — Opus 4.7 rewards literalism and will not infer structure you didn't state.

### Session loop — every cold start

1. This file (auto-loaded) + `docs/continuation.md` → current phase and immediate focus.
2. If focus is ambiguous: read the ADRs it references, then `git log --oneline -20` and `TaskList`.
3. **Front-load the plan before the first edit.** State intent, scope boundaries, relevant file paths, acceptance criteria. Opus 4.7 will not fill these in for you.
4. Execute. Prefer parallel tool calls for independent work; batch related questions into a single turn.
5. On slice completion, update `docs/continuation.md` § Recent history + § Immediate focus, then enter the commit loop.

### Commit loop — every commit, no exceptions

*A bad commit on `main` is expensive to unwind — direct push, no PRs at this phase. This loop is non-optional.*

1. **Stage by path.** `git add <specific-files>`. Never `-A` / `.` for staging. Never `git commit -a` / `-am` / `--all` — those bypass the explicit stage by pulling in every tracked modification, including parallel-agent work and unreviewed edits. The commit step uses the staged snapshot; nothing else.
2. **`/codex:adversarial-review` on the working tree with focus text.** Always pass focus text tied to this slice — name the invariant the change is meant to preserve, the regression mode you'd miss most, and the surface you consider risky. Focus **prioritizes**, it does not filter: Codex still reports material issues outside the focus area (the prompt template explicitly says "weight focus heavily, but still report any other material issue"). Empty focus = generic attack-surface pass, which is noisier and less useful. Run `--background` if the diff is likely > 30s of review time.

   **Skip-review allowlist — strict.** Skip review **only** when the *entire* staged diff is under: `CHANGELOG.md`, `CONTRIBUTING.md`, `README.md`, or files under `docs/**` **excluding** `docs/continuation.md`. Never skip for: `AGENTS.md`, `CLAUDE.md`, `docs/continuation.md`, or any new instruction-bearing file an agent loads at startup or that governs other commits — those always get review because a change there can silently weaken the review policy itself. Every other file class — `package.json`, lockfiles, `lefthook.yml`, `tsconfig*.json`, `biome.json`, Atlas migrations, scripts, CI workflows, test-infra configs — counts as reviewable. Any mix of categories = review.
3. **Remediate every finding.** Edit directly, or delegate mechanical fixes to `/codex:rescue`. Disagreement is fine; silent skipping is not. Judge each finding on Codex's own evidence — it's strong at what it does, but "high" severity on an academic gap isn't the same as a shipping blocker. Capture any rebuttal in the commit body so the reasoning is auditable later.
4. **Re-stage by path.** Step 1's snapshot is stale after step 3.
5. **Re-run `/codex:adversarial-review` until clean** — or until every remaining finding has a captured rebuttal in the commit body.
6. **Local gates green.** `pnpm -w run typecheck`, affected tests, `pnpm run coherence`. Biome runs at the pre-commit hook against *staged* Biome-typed files (see `lefthook.yml` — scoped to `*.{ts,tsx,js,mjs,json,jsonc}` with `--no-errors-on-unmatched`, so a docs/ADR-only commit is fine). **Do not run `pnpm lint`** — it expands to `biome check --write .` and rewrites the whole tree, including parallel-agent work. To pre-check, mirror the hook: `pnpm exec biome check --staged --no-errors-on-unmatched <Biome-typed staged paths>`. If a gate produces file changes, loop back to step 4.
7. **Commit.** Before committing, run `git status --short` and confirm the staged snapshot matches what you last reviewed in step 5. Two drift modes to catch: **filename drift** (new entries) — loop to step 1; **content drift** on a reviewed file (an `MM` or `AM` row means the index was reviewed but the worktree has since diverged) — loop to step 4 to re-stage and step 5 to re-review. A clean snapshot is all `M ` / `A ` / `D ` (index-only, worktree clean) on exactly the files step 5 cleared. Then: `git commit -s` (DCO), imperative subject, body explains the *why*. If AI-assisted, end with a `Co-Authored-By:` trailer crediting the assistant that did the work (Codex-authored change credits Codex, not Claude; human-only commits carry no trailer). For a Claude-authored change this session:
   ```
   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   ```
8. **Never `git push --force` on `main`. Never rewrite `main`.** Fix forward with new commits.

**Codex background mode.** Default `--background` on any codex invocation likely to take > 30s. Timing is judgement; the gate is not.

**Scope guidance.** Pragmatic bundling over tiny splits. Related in-flight work is one commit. Split when a chunk is incomplete/experimental, one half is a revert candidate, or the diff is large enough to blur signal.

### Phase-boundary loop — at the end of each phase

1. Spawn a red-team subagent (Opus). Cross-model (Codex) for ADR-level or BLOCKER-class decisions — it earns its keep on high-stakes calls, not routine ones.
2. Apply findings; unrebutted ones go to `docs/adr/red-team-phase-N.md` with disposition covering every finding regardless of severity (see existing `red-team-phase-{1,2,3,4}.md` for the shape).
3. Update `docs/continuation.md` — close phase N, open phase N+1.
4. Commit + push + post summary to @numman for review before starting phase N+1.

Sub-checkpoints within a phase are autonomous. Don't pause mid-phase for permission.

---

## Hard invariants (product — do not break)

Enumerated in [`docs/brief.md`](docs/brief.md) § Hard invariants. Property tests enforce them (Phase 3+):

1. Per-block-type Markdown fidelity round-trips cleanly under its declared tier (ADR 0013).
2. Any mix of concurrent human/agent edits converges across replicas via the CRDT.
3. Every mutation produces exactly one audit entry; the audit log alone reconstructs final state.
4. Every capability exists on every type-compatible surface (API/CLI/MCP/Web UI) — parity is enforced (ADR 0009/0015).
5. No mutation or tenant-scoped read is reachable without a permission check; no surface re-implements permission logic (ADR 0015).
6. Soft-deletes are recoverable via a first-class capability (ADR 0017).
7. **Content mutations** flow through the CRDT via a single write path — `ctx.transact(doc_id, fn)`; handlers never touch Hocuspocus, Y.Doc, or content-mirror DB tables directly. **Metadata mutations** are dispatcher-tx-only; the authoritative set is `METADATA_ONLY_CAPABILITIES` in `packages/scopes` (ADR 0018). `doc.rename` is a *content* mutation — it edits the title block via `ctx.transact` — and is not in the metadata-only set (F54).
8. Agents are first-class principals with distinct rate limits, audit attribution, and revocation (ADR 0016).

## Working rules (design discipline)

1. **No feature code without an ADR. No ADR without alternatives considered.**
2. **Agents are users.** Every human-facing control has an agent equivalent; review any design that treats them differently.
3. **Determinism is a feature.** Doc-model changes preserve CRDT convergence and per-block Markdown fidelity (ADR 0013). Property tests enforce from Phase 3 onward; pre-harness, reason about it explicitly in the ADR.
4. **Contract tests enforce surface parity.** Capabilities register once; adapters are generated or derived from the registry.
5. **Opus sub-agents only for Claude-spawned subagents** (per @numman, 2026-04-17) — the rule governs Claude Code's own Agent-tool subagents (research, planning, exploration). Spawn when fan-out beats sequential — 4.7 spawns fewer by default, state the rationale. **`/codex:rescue` is a separate channel** (Codex-as-subagent, not Claude-spawned) and is governed by its own Skills entry below; it is not constrained by this rule and may be used as needed.
6. **Parallel agents share the working tree; do not isolate.** Let other agents' unstaged work coexist. Stage your own files by path; `/codex:adversarial-review --scope working-tree` sees everything in the tree, findings scope to the diff regardless. A parallel agent may adjust your in-flight files; review the result after.
7. **Verify library docs at point of use.** Before writing code against any pinned dependency (Hocuspocus, BlockNote, Better Auth, Yjs, Kysely, Atlas, MCP SDK, Next.js, Hono), fetch current docs for the pinned version. If docs contradict an ADR, flag in `docs/continuation.md` before coding around it.
8. **Solo-author + agent flow → direct push to `main`, no PRs.** Switch to PRs when multiple humans contribute. **DCO sign-off on every commit** (`git commit -s`). Imperative subject; body explains the *why*.

## Defend these

Red-team review (`docs/adr/red-team-*.md`) flagged these as load-bearing design decisions, not accidents of convenience. A refactor that undoes one must argue past the rationale below in writing before landing.

- **Closure-based `RegisteredCapability` erasure** (F94). `registerCapability<I, O>()` closes over concrete `I`/`O` inside `invoke` and the audit projection; the registry stores `RegisteredCapability<unknown, unknown>`. Heterogeneous capabilities collect in one `Map` without an `any` escape or a cast at the adapter. Do **not** reintroduce `AnyCapability = Capability<any, any>`; the closure pays for type discipline once per capability, for the life of the project.
- **Errors own their audit projection** (F95). Every `EditorZeroError` subclass implements `abstract toHandlerError()` — no central `switch (err.code)` that silently defaults to `internal`. Adding a subclass forces a compile-time decision about how it audits. Do **not** centralize into a big switch; scalable correctness comes from locality.
- **Registry-first, adapters-derived, parity-by-contract** (F96). Capability registry is the single source of truth; API / CLI / MCP / UI adapters are generated or derived, and contract tests enforce the matrix (invariant 4). Do **not** hand-write a second source "just this one endpoint" — the matrix test will fail, and even if it didn't, the parity invariant starts decaying from the first exception.
- **Honest single-backend envelope** (F97, ADR 0007). Default SQLite; Postgres declared separately with an explicit conformance suite re-running the analyzers Atlas Pro ships. Do **not** paper over the gap with "works on both" prose where code has not run against both — the conformance suite is what earns that claim.
- **Runtime `ctx.transact` at-most-once backstop** (F92). Dispatcher wraps caller-provided `extras.transact`; second call throws `TransactCalledTwiceError`. Defence-in-depth for invariant 7 until `@editorzero/arch-lint` ships the dev-time rule. Do **not** remove the runtime guard when the lint rule lands.

## Gotchas

### Runtime / APIs

- **Hocuspocus 3.4.x** — `onStoreDocument` is non-concurrent per doc; handler must be idempotent. `beforeSync` is no longer awaited; enforce resource limits in `onChange`.
- **BlockNote server-side writes** — `@blocknote/server-util`'s `ServerBlockNoteEditor` is a conversion surface with **no `transact()` method**. For mutations, open a Hocuspocus direct connection and call `editor.transact()` on a `BlockNoteEditor.create({ collaboration: { fragment } })` bound to the live Y.XmlFragment (ADR 0018). `blocksToYDoc` is **not** a rehydration path — it loses history.
- **BlockNote block-ID passthrough** — `blocksToYXmlFragment` honours `PartialBlock.id` when provided (verified in `@blocknote/core/src/api/nodeConversions/blockToNode.ts`); BlockNote only mints its own id when `block.id === undefined`. This is what lets `doc.create` pre-mint `BlockId`s and capture them in the `doc.create` audit effect (invariant 3a).
- **Next.js 16 `"use cache"`** — cached functions cannot call `cookies()` / `headers()` / `searchParams`. Pass request context as arguments.
- **Better Auth `getServerSession`** — cannot be called inside a `"use cache"` scope.
- **Secrets** — never read credentials via `process.env` directly. All secret loads go through `packages/config/secrets.ts` so the source (`file | env | vault`) is typed and rotation hooks land in one place (architecture.md §16.12).

### Pinned versions (do not bump blind)

- **Atlas `migrate lint`** — moved to Pro in v0.38 (Oct 2025). Pin Atlas CE; cover missing analyzers in the conformance suite.
- **sqlite-vec** — ANN is alpha as of v0.1.9. SQLite-mode vector search uses brute force (safe < 1M vectors); ANN is behind an experimental flag.
- **pgvector** — pin ≥ 0.8.2 (CVE-2026-3172 — parallel HNSW buffer overflow).
- **MCP SDK** — pin latest 1.x stable (v2.0.0-alpha.2 is alpha).
- **Node 22 LTS** — EOL April 30 **2027**. Plan Node 24 migration Q3 2026.

---

## File map

| File | What it holds |
|---|---|
| [`docs/continuation.md`](docs/continuation.md) | **Rolling work state. Read first.** |
| [`docs/brief.md`](docs/brief.md) | Phase 0 framing, invariants, assumptions. |
| [`docs/adr/README.md`](docs/adr/README.md) | ADR index + review trails. |
| [`docs/adr/NNNN-*.md`](docs/adr/) | One file per architectural decision. |
| [`docs/architecture.md`](docs/architecture.md) | System design (Phase 2 output), incl. Appendix C verification stack. |
| [`docs/adr/red-team-phase-*.md`](docs/adr/) | Phase-boundary red-team dispositions. |
| `docs/runbook.md` | Operator playbook (Phase 4 output — not yet created). |
| `docs/threat-model.md` | Security posture (Phase 5 output — not yet created). |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-release notes. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | External-contributor onboarding, DCO instructions. |

## Skills

- **`dev-browser:dev-browser`** — browser automation with persistent page state. Use for UI verification, pixel-perfect checks against design, form fills, screenshots, scraping, testing the web app.
- **`/codex:adversarial-review`** — Codex's adversarial reviewer, default on every commit (see commit-loop step 2 for the skip-rule). Always pass focus text tied to the slice's invariants / regression modes / risky surfaces — without focus, Codex runs a generic pass. Structured JSON output (verdict + findings), so rebuttals live in the commit body, not the transcript. `/codex:review` (native) also exists but is unused in this project — adversarial with focus earns its keep everywhere native would.
- **`/codex:rescue`** — **Codex as a subagent.** Write-capable (`--write` default on), persistent thread (`--resume` to chain across turns), sees the repo directly rather than a pre-bundled diff. Delegate when: (a) the work is mechanical and main-Claude's context should stay clean (biome passes, config stubs, typed fixture ports); (b) main-Claude is stuck and benefits from an independent implementation attempt; (c) follow-up work needs to chain — each `--resume` picks up prior thread state. **Always launch with `--background`.** Codex jobs routinely run tens of minutes and synchronous invocations have failed mid-task in this project; `--background` is the safe default for any rescue call. Track progress via `Monitor` on the output file (or `Bash run_in_background=true` and check the output later). Returns Codex's stdout verbatim once complete.

## When in doubt

Ask @numman only if the decision has lasting architectural consequences, the requirement is genuinely ambiguous, or there is a hard external blocker. Research, ADRs, refactors, subagents, backing out bad decisions — those are the agent's job.
