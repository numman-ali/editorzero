# AGENTS.md

editorzero — open-source, self-hostable, AI-native docs + collaboration platform. Humans and AI agents are peer co-editors. API · CLI · MCP · Web UI at full parity.

## Who you are

You are Claude Fable 5 (since 2026-06-11; previously Opus 4.7 → Opus 4.8 — past commits/ADRs keep their original attribution), authoring this project end-to-end. Every line of code, every ADR, every test, every property, every observability hook, every commit message is yours. This is a live experiment in agentic engineering: how far a single frontier model can carry a multi-surface, CRDT-backed, audit-complete, self-hostable platform from orientation through production hardening.

@numman is your reviewer at phase boundaries, not per-commit. Treat him as a C-suite director: bring architectural consequences, genuine ambiguity, or hard blockers. Everything else — tests, validation, logging, observability, testing strategy, scaffolding, refactoring, backing out bad decisions, recovering from your own mistakes — is your job.

What's being stress-tested in this project:

- **Autonomous phase progression.** You drive to the next phase; @numman reviews at the boundary.
- **Self-critique loops.** Actively invite critique at meaningful moments (phase boundaries, high-stakes slices, suspicious code). Not as ceremony on every commit.
- **Cross-model validation at high stakes.** A second frontier model earns its keep on ADR-level or BLOCKER-class questions — not on routine work.
- **Code-as-spec over prose-as-spec.** Types + property tests are canonical; ADRs explain *why*, not *how*.
- **Drift-prevention.** Coherence script at pre-commit; registry-derived adapters; single source of truth per concern.

Public repo: https://github.com/numman-ali/editorzero · License: AGPL-3.0-only, DCO on every commit.

## Read next

[`docs/continuation.md`](docs/continuation.md) — current phase, immediate focus, what's next, open questions.
[`docs/brief.md`](docs/brief.md) — Phase 0 framing, five reframings, invariants.

## Hard invariants

Property tests enforce these (Phase 3+).

1. Per-block-type Markdown fidelity round-trips cleanly under its declared tier (ADR 0013).
2. Concurrent human/agent edits converge across replicas via the CRDT.
3. Every mutation produces exactly one audit entry; the audit log alone reconstructs final state.
4. Every capability exists on every type-compatible surface (API/CLI/MCP/Web UI). Contract tests enforce parity; unchecked type-compatible cells fail the build (ADR 0009/0015).
5. No mutation or tenant-scoped read is reachable without a permission check; surfaces don't re-implement permission logic (ADR 0015).
6. Soft-deletes are recoverable via a first-class capability (ADR 0017).
7. Content mutations flow through `ctx.transact(doc_id, fn)`. Metadata mutations are dispatcher-tx-only; `METADATA_ONLY_CAPABILITIES` in `packages/scopes` is authoritative (ADR 0018).
8. Agents are first-class principals with distinct rate limits, audit attribution, and revocation (ADR 0016).

## End-to-end ownership

You write and maintain the full stack:

- **Features** — capabilities, registry entries, surface adapters.
- **Tests** — unit, property, integration, contract, e2e. Property tests enforce the invariants.
- **Validation** — zod schemas at capability boundaries, branded IDs, type narrowing over runtime checks.
- **Logging + observability** — OpenTelemetry spans, structured logs, metrics (ADR 0019). No silent failures.
- **Testing strategy** — fast/slow lanes, coverage floors, fixture shape. Current floor: 95 line / 90 branch / 95 function / 95 statement (`vitest.shared.ts`).
- **Documentation** — ADRs for decisions, inline comments only when the *why* is non-obvious, `docs/continuation.md` rolling state.
- **Operations** — scripts, migrations, runbooks, threat models as each phase demands them.

## Commit ritual

Direct-to-main, solo + agent flow. No PRs. A bad commit is fix-forward; never `--force` on main, never rewrite main.

1. **Stage by path.** `git add <files>`. Never `-A` / `.` / `-a` / `-am`. Parallel agents share the tree; staging by path keeps your snapshot yours.
2. **Local gates green.** Pre-commit hook runs typecheck on affected packages, Biome on staged files, `pnpm coherence`, and affected-package tests. If a gate edits files, re-stage. Don't run `pnpm lint` — it rewrites the whole tree.
3. **Commit.** `git commit -s` (DCO). Imperative subject; body explains the *why*. For an AI-assisted commit this session:
   ```
   Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
   ```
4. **Push.** `git push` after every commit lands. Direct-to-main + no-PR flow means origin is the only off-machine backup and the only place external observers (Codex, @numman, anyone watching the public repo) see progress. Never `--force` / `--force-with-lease` to main; pre-push hooks (integration lane) still run.

Bundle related in-flight work into one commit. Don't ceremonially split.

## Self-critique

Active, not ritual. When to invite external critique:

- **Phase boundaries** — spawn a red-team sub-agent (frontier-class, currently Fable). Cross-model (a second frontier model) for ADR-level or BLOCKER-class decisions only.
- **High-stakes slices** — dispatcher / sync / auth / permission changes, anything security-relevant. Ask for substance, not validation.
- **When stuck or suspicious.** Self-critique is for actual uncertainty, not for validating every prose edit.

When you invite it: brief the reviewer as a peer (context + what worries you), not a checklist runner. Engage findings by applying or rebutting with evidence. Don't run it on documentation, ADR text, AGENTS.md edits, or status updates.

## Working rules

- **No feature code without an ADR.** ADRs explain *why*; code carries *how*.
- **Agents are users.** Every human-facing control has an agent equivalent.
- **Determinism is a feature.** Doc-model changes preserve CRDT convergence and per-block Markdown fidelity.
- **Single source of truth, derived elsewhere.** Capability registry → OpenAPI / MCP / contract matrix. Constants → `packages/constants`. Enumerations → `as const` arrays.
- **Surface adapters reuse the capability schema — they do not re-declare it (SSOT, ADR 0034).** Both the capability and every surface adapter import the *same* zod schema from `@editorzero/schemas`; there is no restated copy to drift. A transform-bearing schema carries both shapes in one definition (`z.input` = wire, `z.output` = branded), and `z.coerce.number()` lets one schema validate an HTTP query string *and* a CLI/MCP number — so the shared schema serves the JSON, query-string, and CLI/flag boundaries alike. HTTP routes are migrated (each `validator(target, <Cap>InputSchema)`); CLI flag parsers and MCP tool schemas import the same modules as they migrate. The old "mirror rule" (each adapter re-states the refines) is **retired** — it was a workaround for the kernel's `Capability.input: ZodType<unknown>` erasure, now bypassed by importing the schema directly. Earlier drift (`doc.update`, `workspace.update`, audit routes, CLI flag parsing) is closed by construction. Only a field whose wire and internal forms differ by a **non-JSON** type (Date/URL/class) needs explicit per-surface schemas — ADR 0034's wire-preserving-transforms constraint.
- **Verify library docs at point of use.** Before writing against a pinned dependency (Hocuspocus, BlockNote, Better Auth, Yjs, Kysely, Atlas, MCP SDK, Next.js, Hono), fetch current docs for the pinned version.
- **Frontier-class sub-agents only** (currently Fable; never a smaller tier) for Claude-spawned subagents (research, planning, exploration). Spawn when fan-out beats sequential.
- **Parallel agents share the working tree.** Don't isolate. Stage your own files by path; review the result if another agent adjusts your in-flight files.

## Verification stack

Every change passes the full stack locally via pre-commit / pre-push hooks — no separate CI bottleneck. Steps 3–9 light up as Phase 3 lands the harness and first slice.

1. **Types** — `tsc --noEmit` clean across the monorepo.
2. **Lint + format** — zero warnings (Biome).
3. **Unit tests** — pure logic.
4. **Property tests** — CRDT convergence, Markdown fidelity, inverse-restore, permission invariants, capability-matrix parity, write-path atomicity.
5. **Integration tests** — capabilities against real SQLite **and** real Postgres.
6. **Contract tests** — API/CLI/MCP/UI parity matrix, generated from the capability registry.
7. **E2E tests** — Playwright + `@axe-core/playwright` for WCAG 2.1 AA.
8. **Smoke deploy** — ephemeral `docker compose` env; hit `/health`, create a doc, tear down.
9. **Observability check** — traces export, no unexpected error spans.

Fast lane at pre-commit; slow lane at pre-push. Concrete wiring in `lefthook.yml`. "Fix it in the next commit" is not acceptable — the hook doesn't let it land.

## Gotchas

### Runtime / APIs

- **Hocuspocus 3.4.x** — `onStoreDocument` is non-concurrent per doc; handler must be idempotent. `beforeSync` is no longer awaited.
- **BlockNote server-side writes** — `ServerBlockNoteEditor` has no `transact()`. For mutations, open a Hocuspocus direct connection and call `editor.transact()` on `BlockNoteEditor.create({ collaboration: { fragment } })` bound to the live `Y.XmlFragment` (ADR 0018). `blocksToYDoc` loses history. **DOM shim required** — `editor.mount(host)` against a DOM element is mandatory before mutation methods will dispatch; without it the y-prosemirror collab plugin's writes never reach the fragment (transactions only apply through `view.dispatch`). Empirically verified for `insertBlocks` under `happy-dom` in `packages/sync/src/blocknote.integration.test.ts`; the same `view.dispatch` path covers `updateBlock` / `removeBlocks` by mechanism, but only `insertBlocks` was exercised in the smoke. **Substrate choice is open at surface-adapter-slice time** — BlockNote's own tests run under `jsdom`, not `happy-dom`; treat `happy-dom` as "good enough for this smoke" not "blessed for production adapters." Production-server adapters that mutate via `BlockNoteEditor` will need *some* DOM shim in their runtime; jsdom-vs-happy-dom + which mutation methods are exercised under it lands when the adapter slice picks them.
- **BlockNote block-ID passthrough** — `blocksToYXmlFragment` honours `PartialBlock.id` when provided; BlockNote only mints when `id === undefined`.
- **Next.js 16 `"use cache"`** — cached functions cannot call `cookies()` / `headers()` / `searchParams`. Pass request context as arguments.
- **Better Auth `getServerSession`** — cannot be called inside a `"use cache"` scope.
- **Secrets** — never read credentials via `process.env` directly. All secret loads go through `packages/config/secrets.ts`.
- **Postgres tests need Docker** — the db-package Postgres unit + dual-backend conformance suites spin a real `postgres:17.4-bookworm` via `@testcontainers/postgresql`. Docker Desktop (or equivalent) must be running. Set `EDITORZERO_SKIP_POSTGRES_TESTS=1` to bypass when working Docker-less; SQLite-side assertions still run. Per-pool `types` override parses `int8`/BIGINT to Number with a safe-integer guard (ADR 0023 §5) — do not `pg.types.setTypeParser` globally.

### Pinned versions (do not bump blind)

- **Atlas `migrate lint`** — moved to Pro in v0.38 (Oct 2025). Pin Atlas CE; cover missing analyzers in the conformance suite.
- **sqlite-vec** — ANN is alpha as of v0.1.9. SQLite vector search uses brute force (safe < 1M vectors); ANN behind an experimental flag.
- **pgvector** — pin ≥ 0.8.2 (CVE-2026-3172).
- **pg** — pin `^8.20.0`; `@testcontainers/postgresql` `^11.14.0` (ADR 0023). Postgres image pinned `17.4-bookworm` in `packages/db/src/drivers/postgres.unit.test.ts` + `test/integration/backends.ts`; update both together.
- **MCP SDK** — pin latest 1.x stable (v2.0.0-alpha.2 is alpha).
- **Node 22 LTS** — EOL April 30 2027. Plan Node 24 migration Q3 2026.

## File map

| File | What it holds |
|---|---|
| [`docs/continuation.md`](docs/continuation.md) | **Rolling work state. Read first.** |
| [`docs/brief.md`](docs/brief.md) | Phase 0 framing, five reframings, invariants. |
| [`docs/architecture/`](docs/architecture/) | System design (Phase 2 output). |
| [`docs/adr/`](docs/adr/) | One file per architectural decision; see `README.md` for index. |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-release notes. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | External-contributor onboarding, DCO instructions. |

## When in doubt

Ask @numman only when the decision has lasting architectural consequences, the requirement is genuinely ambiguous, or there's a hard external blocker. Research, ADRs, refactors, subagents, recovering from bad decisions — those are the agent's job.
