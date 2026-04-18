# Continuation — rolling work state

*Rolling work-state journal. `AGENTS.md` (= `CLAUDE.md`) is already in your context — it is auto-loaded on every session. This file is what an agent updates as work progresses; commit with each phase-boundary update.*

---

## Current phase

**Phase 2 (architecture) CLOSED 2026-04-18.** Three red-team passes (F1–F30 / F31–F53 / F54–F84, cross-model Opus + Codex on pass-3) all applied. Architecture stabilized at ~2616 lines; ADRs 0004, 0006, 0007, 0014, 0016, 0018 updated to match; AGENTS.md invariants refined; disposition docs under `docs/adr/red-team-phase-{1,2,3}.md`. Phase 3 (verification harness) open.

## Immediate focus — Phase 3 kickoff

**Harness before features.** Order matters here — every Phase 3 item is a drift-prevention primitive before it's a feature-enabling primitive.

1. **Monorepo scaffold + pre-commit hooks.** `packages/{config,capabilities,dispatcher,auth,auth-service,scopes,constants,webhooks,…}` per architecture.md §16.1. Biome + tsc pre-commit; fast path (types + lint + affected unit) + slow path (property + integration + contract + e2e + smoke) on pre-push.
2. **Coherence script at pre-commit** (the drift-prevention investment I flagged to @numman, 2026-04-17). ~100 lines of TS that greps: section references exist, capability IDs in Appendix A ↔ registry ↔ `AuditEffect` union match 1:1, numeric constants referenced by name (no duplicated literals across docs), ADR cross-refs exist. Fails the commit on divergence. Not a framework — a script.
3. **`packages/constants/`** — single source of truth for numeric floors (72h tombstone, 100MB attachment cap, 500 updates/sec, …). Docs cite named constants, not literals.
4. **Typed invariant enumerations** — `METADATA_ONLY_CAPABILITIES = [...] as const`. AGENTS.md + §6.5 + §17.1 reference the const name. Contract test asserts list matches `capability.category`.
5. **"Create doc, read doc" end-to-end slice** across all four surfaces with the verification stack green (types → lint → unit → property → integration-both-drivers → contract → e2e → smoke → OTel).
6. **Open verification from ADR 0018** — prototype `BlockNoteEditor.create({ collaboration }) inside openDirectConnection.transact()` under concurrent human+agent edits; close the open-question in the ADR with empirical evidence or revise.
7. **Appendix C entry checklist** (architecture.md) — work down the list; each item is green before Phase 3 exits.

## Drift-prevention posture (new, Phase 3 onward)

Root-cause observations from the three red-team passes: prose-as-spec hides bugs that types + tests catch instantly; hand-maintained duplicates drift. Therefore:

- **Code-as-spec over prose-as-spec.** Types + property tests are canonical. ADRs explain *why*, not *how*.
- **Single source of truth, derived elsewhere.** Registry → OpenAPI / MCP / contract matrix / Appendix A. Constants → `packages/constants/`. Enumerations → `as const` arrays.
- **Coherence script at pre-commit** (item 2 above) is the load-bearing enforcement.
- **Cross-model red-team reserved for ADR-level decisions + phase boundaries.** Not routine — it earns its keep on BLOCKER-class questions (pass-3 caught invalid SQL that way). Per-PR is ceremony.
- **Small diffs per commit during implementation.** Big sub-agent fix-batches regressed things in Phase 2 (pass-3's F74 was introduced by pass-2's F40 fix). Small focused edits + CI gate are the Phase 3 discipline.

## Resume protocol (for a fresh-context agent)

1. **`AGENTS.md` is already loaded** via the CLAUDE.md symlink — canonical rules + invariants + gotchas are in your context.
2. **This file is your next read** — current phase, immediate focus, open questions (below).
3. Read `docs/brief.md` — Phase 0 framing.
4. Read `docs/adr/README.md` — ADR index.
5. Skim `docs/adr/red-team-phase-1.md` + `docs/adr/refresh-research-phase-1.md` for the reasoning trail behind the stack (why we landed here, not just what).
6. `git log --oneline -20` — work-in-progress head.
7. `TaskList` — task state carries across sessions. Also: check the latest `docs/adr/red-team-phase-*.md` for outstanding unrebutted findings.
8. **Do not read all 20 ADRs front-to-back unless necessary.** Read only those relevant to the immediate focus.
9. If any "Open questions" below would block the next action, raise them before acting.

## Open questions for @numman

1. **Commercial arm** (carried from `docs/brief.md`): OSS-only or OSS + hosted? AGPL-3.0 + DCO (ADR 0001) does not pre-commit the answer; adopting any `@blocknote/xl-*` package in the future would foreclose permissive/dual-license moves (ADR 0004). **Still open; does not block Phase 3.**
2. **Agent offline-edit** (carried from `docs/brief.md`): do agents get offline/reconcile semantics or are they assumed always-online? Default "always-online" stands unless challenged. **Still open; does not block Phase 3.**

### Archived (resolved 2026-04-17)
- Scale target — 500–1,000 minimum, 10k headroom. Folded into [ADR 0007](adr/0007-database-strategy.md).
- Sub-block ACLs — deferred; `AccessPath.selector` reserved. Folded into [ADR 0015](adr/0015-permission-enforcement.md).
- BlockNote vs Tiptap — re-validated via research pass; BlockNote confirmed, ADR 0004 + 0018 corrected on primitive naming and license framing.

Nothing open blocks Phase 3. Defaults for (1) and (2) are captured in `architecture.md`.

## Recent history

- **2026-04-17 (Phase 0 + 1):** Phase 0 scaffolded → Phase 1 v1 ADRs (12 → 19, after first red-team pass) → Phase 1 v2 ADRs (post-refresh; BlockNote replaces Milkdown, Better Auth consolidation, Next 16.2, block-model rewrite, new git-mirror ADR 0020). Public repo created at https://github.com/numman-ali/editorzero. Workflow confirmed: direct-to-main, pre-commit hooks, no PRs needed.
- **2026-04-17 (Phase 2 — drafting):** `docs/architecture.md` drafted end-to-end (data model, capability matrix, four-surface adapters, permission worked examples, event/audit model, OpenAPI + MCP surface drafts, verification wiring, engineering primitives §16 for agentic coding). Red-team pass #1 produced F1–F30; applied.
- **2026-04-17 (Phase 2 — BlockNote validation):** research pass confirmed stack vs Tiptap; corrected ADR 0018 write-path primitive naming (`ServerBlockNoteEditor.transact` → `BlockNoteEditor.create({ collaboration }).transact` inside `openDirectConnection.transact`) and ADR 0004 license framing + DINUM/ZenDiS funding signal. AGENTS.md + continuation.md audit + edits applied.
- **2026-04-17 (Phase 2 — pass #2):** red-team pass #2 produced F31–F53 (3 BLOCKER: audit atomicity, deny/error audit, move-op; 7 HIGH: DR, secrets, seq HA, reconcile clobber, residency, HNSW memory, outbox HA; 9 MEDIUM; 4 LOW). All applied. Architecture grew 2061 → 2434 lines.
- **2026-04-18 (Phase 2 — pass #3, cross-model):** Opus + Codex independent red-team pass on the same prompt. Opus produced F54–F72; Codex produced F73–F84 (renumbered from C54–C65 to avoid collision). Combined: 25 unique findings — 3 BLOCKER (`state_vector_at_fetch` unreconstructible → replaced with opaque `reconcile_base_token`; HA outbox lost-event regression from pass-2 F40 → single-tx claim+enqueue; `SELECT max(seq) FOR UPDATE` invalid SQL → `doc_counters` row-lock), 10 HIGH (ADRs 0006/0018 stale; `CapabilityContext.transact` type wrong; `doc.rename` misclassified; webhook CRUD + attachment multi-step missing from Appendix A; `mirror.reset` split; revocation event-key mismatch; secret cache vs rotation; orphan uploads), 10 MEDIUM, 2 LOW. All applied. Architecture at 2616 lines. Phase 2 CLOSED. Cross-model review proved its keep: Codex caught three BLOCKERs Opus missed; Opus caught the `CapabilityContext` type bug Codex missed.
- **2026-04-18 (Phase 3 — foundational packages landing):** P3.1–P3.4 wrapped for the contract layer. Packages now real: `constants` (numeric SSOT), `ids` (branded + UUIDv7/v4 validators), `scopes` (Role/Scope/Surface/CapabilityCategory/SubjectKind + METADATA_ONLY_CAPABILITIES + AGENT_SCOPE_TIERS + QueueName + FidelityTier as-const arrays), `audit` (~90 AuditEffect variants from §16.3 + AuditRecord envelope + AuditWriter interface), `principal` (UserPrincipal/AgentPrincipal union + TenantContext + AccessPath + reserved SubBlockSelector brand), `capabilities` (Capability<I,O> + CapabilityContext kernel), `errors` (EditorZeroError family per §16.10). Toolchain decisions: `moduleResolution: "Bundler"` + `module: "Preserve"` so relative imports stay extensionless (bundlers handle resolution at app build; `tsc -b` emits for typecheck only); `useNamingConvention` off (snake_case mirrors DB columns throughout; enforcing camelCase would need a mapping layer without safety gain); kernel's `CapabilityContext<TEditor>` is generic with default `unknown` so the package stays dep-light, sharpened to `BlockNoteEditor<BlockSpecSchema>` when `@editorzero/blocks` lands. One arch-drift fix applied: `admin.diagnose` AuditEffect variant was missing from §16.3 but referenced in Appendix A — added to both code + arch. Remaining P3: dispatcher, db, sync, blocks, auth(+service), api-server, cli, mcp-server, jobs, mirror, webhooks, observability, config, contract-tests, e2e, apps/{app,admin} — scaffold lazily as the P3.5 "create doc, read doc" slice pulls them in.

## Signals to check when resuming

- If `docs/architecture.md` exists and has content → Phase 2 is underway.
- If `package.json` / monorepo tooling exists → Phase 3 harness is underway.
- If route handlers / capability implementations exist → Phase 4 slices are underway.
- If security pass / load tests / runbook artifacts exist → Phase 5.

## Update protocol for future me

- At every phase boundary: update the "Current phase," "Immediate focus," and "Recent history" sections; commit with a message like `continuation: close Phase N, open Phase N+1`.
- Mid-phase, if context is about to be compacted and important nuance is at risk of loss, flush a short note to the "Recent history" section so it's visible on next load.
- When an "Open question" is answered, strike it through (do not delete — the record is useful) and add a note about what the answer was.
