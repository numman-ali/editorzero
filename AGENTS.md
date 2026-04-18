# AGENTS.md

You are reading `AGENTS.md`. `CLAUDE.md` is a symlink that points at this exact file, so Claude Code auto-loads it on every session — there is **one file on disk** with two names. Editing either edits both. When guidance here says "AGENTS.md," that is the same thing as the CLAUDE.md your runtime loaded.

This file is the durable anchor: commit discipline, invariants, verification stack, working rules, gotchas. Update it only when a working practice genuinely changes.

**Your next read is [`docs/continuation.md`](docs/continuation.md)** — the rolling work state: current phase, immediate focus, open questions, resume protocol. Time-varying information lives there so this file can stay stable.

---

## Commit ritual — every commit, no exceptions

**If you are about to run `git commit` and you cannot point to when you completed each step below, you haven't. Run them now.**

This is the rule most often skipped under pressure; it is the one with the worst consequences when skipped. A bad commit on `main` is expensive to unwind because `main` is directly pushed.

1. **Stage by path.** `git add <specific-files>`. Never `git add -A`, `git add .`, or similar bulk stages — they pick up sensitive files, build artifacts, and parallel-agent work you did not mean to include.
2. **`/codex:review` on the working tree.** Non-optional. Size of diff is irrelevant (1 file or 50, all get reviewed). Treat it like a senior collaborator leaving inline comments on your PR — findings are addressed, not filed.
3. **Address every finding.** Edit directly, or delegate small-fix application to `/codex:rescue` (particularly useful when you want to stay focused on architecture work while rescue picks up mechanical fixes). Disagreement is fine; silently ignoring a finding is not.
4. **Re-stage the paths you edited while remediating.** `git add <specific-files>` again. Step 1's staged snapshot is now stale — if you skip this, the fixes from step 3 won't be in the commit and you'll ship the pre-review version. Still no `-A` / `.` bulk stages; re-stage by path, the same set you touched.
5. **Re-run `/codex:review` until clean** — or until every remaining item has an explicit rationale for rejection, captured in the commit body if material.
6. **`/codex:adversarial-review` if the commit makes a non-trivial design choice.** Triggering shapes: new ADR, schema change, permission rule, write-path primitive, capability shape, audit-envelope field, error-taxonomy extension. Apply those findings the same way (remediate → re-stage → re-review). Pure bug fixes and straightforward implementation rounds do not trigger this.
7. **Local gates green.** `pnpm -w run typecheck`, affected tests pass, `pnpm run coherence` clean. Biome runs check-only against *staged* Biome-typed files at the commit hook (see `lefthook.yml` — scoped to `*.{ts,tsx,js,mjs,json,jsonc}` with `--no-errors-on-unmatched`, so a docs/ADR-only commit is fine). If you want to pre-check, mirror the hook: `pnpm exec biome check --staged --no-errors-on-unmatched <Biome-typed staged paths>`. Do **not** use `pnpm lint` — it expands to `biome check --write .` and will rewrite every file in the working tree including a parallel agent's unstaged work (rule 9). The pre-commit hook will catch failures, but surfacing them at hook time wastes a roundtrip. **If a gate produces file changes** — a test/type fix you apply here, coherence rewriting a file, Biome autofix you opted into — **loop back to step 4** (re-stage) and step 5 (re-run `/codex:review`). Uncommitted fixes are indistinguishable from new code; they get reviewed the same way.
8. **Commit.** `git commit -s` (DCO), imperative-mood subject, body explains the "why." If the commit was AI-assisted, end with a `Co-Authored-By:` trailer crediting the assistant that actually did the work (README.md + CONTRIBUTING.md scope this to AI-assisted commits; human-only commits don't carry it, a Codex-authored change credits Codex, not Claude). For a Claude-authored change this session uses:
   ```
   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   ```
9. **Never `git push --force` or rewrite `main`.** Fix forward with new commits.

**Default `--background`** on any codex invocation that will take > 30s. Timing and mode are your judgement; the gate itself is not.

**Scope guidance.** Pragmatic bundling over tiny splits. Related in-flight work that landed in the same session is one commit; manufacturing boundaries between "conceptually separate" scopes is friction for no benefit. Split when: a chunk is incomplete/experimental and the rest isn't; one half is a revert candidate; the diff is large enough that reviewing it as one blurs signal.

**When to use each codex mode.**
- **`/codex:review`** — straightforward code review, every commit. Like a collaborator reading a diff.
- **`/codex:adversarial-review`** — design-level challenge review. Asks "is this the right approach?", not "is the code correct?" Reserved for the triggers in step 6 of the commit ritual. Distinct from rule 5 in Working rules (phase-boundary red-team, which produces `docs/adr/red-team-*.md`).
- **`/codex:rescue`** — delegate a substantial coding task when stuck, when a second pass is faster, or when iteration is burning wall-clock. Also: apply remediations from a `/codex:review` pass so the primary agent stays on architecture. For adversarial-review findings, use judgement — design fixes often want to stay on the primary reasoning thread.

---

## Hard invariants (product — do not break)

Enumerated in [`docs/brief.md`](docs/brief.md) § Hard invariants. Property tests enforce them (Phase 3+):

1. Per-block-type Markdown fidelity round-trips cleanly under its declared tier (ADR 0013).
2. Any mix of concurrent human/agent edits converges across replicas via the CRDT.
3. Every mutation produces exactly one audit entry; the audit log alone can reconstruct final state.
4. Every capability exists on every surface it is type-compatible with (API/CLI/MCP/Web UI) — parity is enforced, not aspired to (ADR 0009/0015).
5. No mutation or tenant-scoped read is reachable without a permission check; no surface re-implements permission logic (ADR 0015).
6. Soft-deletes are recoverable via a first-class capability (ADR 0017).
7. **Content mutations** flow through the CRDT via a single write path — capability handlers receive `ctx.transact(doc_id, fn)` and never touch Hocuspocus, Y.Doc, or content-mirror DB tables directly. **Metadata mutations** (`block.set_visibility`, `doc.publish`, `doc.unpublish`, `doc.move`, `collection.*`) are dispatcher-tx-only and enumerated explicitly (ADR 0018). `doc.rename` is a **content** mutation — it edits the title block via `ctx.transact` — and is not in the metadata-only set (F54).
8. Agents are first-class principals with distinct rate limits, audit attribution, and revocation (ADR 0016).

---

## Working rules (design discipline)

1. **No feature code without an ADR.** No ADR without alternatives considered.
2. **Agents are users.** Every human-facing control has an agent equivalent. Review any design that treats them differently.
3. **Determinism is a feature.** Doc-model changes must preserve CRDT convergence and per-block Markdown fidelity (ADR 0013). Property tests enforce this from Phase 3 onward; pre-harness, reason about it explicitly in the ADR.
4. **Contract tests enforce surface parity.** Do not add a capability on one surface without adding it on every type-compatible surface. Generate adapters from the capability registry where possible.
5. **Self-critique at phase transitions.** Spawn a red-team subagent with the plan/diff; treat findings as blocking until fixed or rebutted in writing (see `docs/adr/red-team-*.md`). This is distinct from the commit-time `/codex:adversarial-review` above — phase-boundary red-teams produce a `docs/adr/red-team-*.md` disposition file covering every finding regardless of severity (see the existing `red-team-phase-{1,2,3}.md` files for the shape).
6. **Stop at phase boundaries.** At the end of each phase, update `docs/continuation.md`, commit, push, and post a summary to @numman for review before proceeding. Sub-checkpoints within a phase are autonomous — don't ask mid-phase for permission.
7. **Opus sub-agents only** (per @numman, 2026-04-17).
8. **Verify library/tool docs at point of use.** Before writing code against any pinned dependency (Hocuspocus, BlockNote, Better Auth, Yjs, Kysely, Atlas, MCP SDK, Next.js, Hono, etc.), fetch the current docs for the pinned version and confirm the API shape. Pinned versions drift; the gotchas list is populated by doing exactly this. If docs contradict an ADR, flag it in `docs/continuation.md` before coding around it.
9. **Parallel agents share the working tree; do not isolate.** When another agent (Codex, a second Claude session) is working in the same repo, treat their unstaged / untracked changes the way you would treat any sub-agent's output — let it coexist with yours. Do **not** `git stash`, worktree-carve, or otherwise quarantine their work to build an "isolated" review scope. Stage your own files by path; let `/codex:review --scope working-tree` see everything that is actually in the tree; the findings will be scoped to the diff regardless. The same posture applies in reverse: a parallel agent may freely adjust your in-flight changes (including applying its own review findings to files you staged), and you review the result after.
10. **Solo-author + agent flow; direct push to `main`, no PRs.** If/when multiple humans contribute, switch to PRs and revise this rule. **DCO sign-off on every commit** (`git commit -s`). Commit messages: imperative subject, body explains the "why," not the "what."

---

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

`/codex:review` runs **before** this stack, not inside it. Automated gates catch machine-checkable defects; codex catches semantic ones.

---

## Defend these

Patterns red-team review (`docs/adr/red-team-*.md`) flagged as load-bearing design decisions, not accidents of convenience. A refactor that undoes one is not a "cleanup" — it must argue past the rationale below in writing before landing.

- **Closure-based `RegisteredCapability` erasure** (F94). `registerCapability<I, O>()` closes over the concrete `I` / `O` inside `invoke` and the audit projection, then returns a `RegisteredCapability` typed as `<unknown, unknown>` at the registry boundary. This is how heterogeneous capabilities collect in one `Map` without an `any` escape or a cast at the adapter. **Do not** reintroduce a cast-based `AnyCapability = Capability<any, any>` alias — the closure pays for type discipline once per capability, for the life of the project.
- **Errors own their audit projection** (F95). Every `EditorZeroError` subclass implements `abstract toHandlerError()` — there is no central `switch (err.code)` that silently defaults to `internal`. Adding a new subclass forces a compile-time decision about how it audits. **Do not** centralize this into a big switch statement; the scalable-correctness property comes from locality.
- **Registry-first, adapters-derived, parity-by-contract** (F96). The capability registry is the single source of truth; API / CLI / MCP / UI adapters are generated or derived from it, and `contract-tests` enforce the matrix (invariant 4). **Do not** hand-write a second source of truth in an adapter ("just this one endpoint") — the matrix test will fail, and even if it didn't, the parity invariant starts decaying from the first exception.
- **Honest single-backend envelope** (F97, ADR 0007). Default to SQLite; Postgres is declared separately with an explicit conformance suite that re-runs the analyzers Atlas Pro ships. **Do not** paper over the gap with "works on both" prose when the code has not run against both — the conformance suite is what earns that claim.
- **Runtime `ctx.transact` at-most-once backstop** (F92). The dispatcher wraps caller-provided `extras.transact` in a one-shot guard; a second call throws `TransactCalledTwiceError`. This backstops invariant 7 until `@editorzero/arch-lint` ships the dev-time rule. **Do not** remove the runtime guard when the lint rule lands — defence-in-depth is the point.

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

---

## Gotchas

Maintained as we discover them.

### Runtime / APIs
- **Hocuspocus 3.4.x:** `onStoreDocument` is non-concurrent per doc; handler must be idempotent. `beforeSync` is no longer awaited; enforce resource limits in `onChange`.
- **BlockNote server-side writes:** `@blocknote/server-util`'s `ServerBlockNoteEditor` is a conversion surface — it has **no `transact()` method**. For mutations, open a Hocuspocus direct connection and call `editor.transact()` on a `BlockNoteEditor.create({ collaboration: { fragment } })` bound to the live Y.XmlFragment (ADR 0018). `blocksToYDoc` is explicitly **not a rehydration path** — it loses history.
- **BlockNote block-ID passthrough:** `blocksToYXmlFragment` honours `PartialBlock.id` when provided (verified in `@blocknote/core/src/api/nodeConversions/blockToNode.ts`) — BlockNote only mints its own id when `block.id === undefined`. This is what lets `doc.create` pre-mint `BlockId`s and capture them in the `doc.create` audit effect (invariant 3a).
- **Next.js 16 `"use cache"`:** cached functions cannot call `cookies()`/`headers()`/`searchParams`. Design cached functions to receive request context as arguments.
- **Better Auth `getServerSession`:** cannot be called inside a `"use cache"` scope.
- **Secrets:** never read credentials via `process.env` directly. All secret loads go through `packages/config/secrets.ts` so the source (`file | env | vault`) is typed and rotation hooks land in one place (architecture.md §16.12).

### Pinned versions (do not bump blind)
- **Atlas `migrate lint`:** moved to Pro in v0.38 (Oct 2025). Pin Atlas CE; cover missing analyzers in the conformance test suite.
- **sqlite-vec:** ANN is alpha as of v0.1.9. SQLite-mode vector search uses brute force (safe < 1M vectors); ANN is behind an experimental flag.
- **pgvector:** pin >= 0.8.2 (CVE-2026-3172 — parallel HNSW buffer overflow).
- **MCP SDK:** pin latest 1.x stable (v2.0.0-alpha.2 is alpha).
- **Node 22 LTS:** EOL April 30 **2027**. Plan Node 24 migration in Q3 2026.

---

## Available skills (Claude Code)

- **`dev-browser:dev-browser`** — browser automation with persistent page state. Use for UI verification, pixel-perfect checks against design, filling forms, taking screenshots, scraping, testing the web app. Trigger when you need to visually confirm UI work.

Codex skills (`/codex:review`, `/codex:adversarial-review`, `/codex:rescue`) — governance and triggers are in the **Commit ritual** section at the top of this file, not duplicated here.

## When in doubt

Ask @numman. But only if the decision has lasting architectural consequences, the requirement is genuinely ambiguous, or there is a hard external blocker. Research, ADRs, refactors, subagents, backing out bad decisions — those are the agent's job.
