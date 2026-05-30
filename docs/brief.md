# AI-Native Docs Platform — Phase 0 Brief

## What this is
An open-source, self-hostable, Markdown-first documentation and collaboration platform where human users and AI agents are peer co-editors. Deployable with one command. API-first, with CLI, MCP server, and Web UI at functional parity. Editor quality targeted at Linear docs, Notion, Craft.

## The reframings that matter

1. **Agent-first is the whole architecture, not a feature.** Every layer — auth, identity, attribution, audit, rate limits, recoverability, API shape — has to treat agents as distinct principals with their own tokens, quotas, and trace identities. Retrofitting this later is how "agent support" becomes a toy.
2. **Four-surface parity is the center-of-gravity constraint.** API/CLI/MCP/UI parity forces a single capability layer that every surface adapts to. If any surface has bespoke mutation logic, we have lost. Contract tests enforce this, not hope.
3. **Markdown round-trip determinism is the hard test.** It means the CRDT document model maps losslessly to and from a canonical Markdown AST. This constrains the editor choice and shapes the block/node schema. Editors that model their DOM as "whatever looks right in the browser" fail here.
4. **"Humans + agents edit simultaneously" = CRDT convergence AND editor correctness.** The editor must accept programmatic edits concurrent with keystrokes without flickering, losing cursor state, or corrupting the CRDT. Not all editors handle this well.
5. **Taste is table stakes for docs.** The gap between "it works" and "people want to write in it" is bigger than it looks. Slash commands, table UX, drag-and-drop feel, paste handling, collab cursors, and hierarchy navigation are where users decide whether to stay.

## Working interpretations

- **"Full parity"** means every mutation and query is invokable through every surface. CLI does not need drag-and-drop; it does need "set doc parent to X."
- **Workspace ≈ department.** One deployment holds many; cross-space reads are allowed but opt-in via configuration. Permission resolution: role default < space default < doc override.
- **Principals are polymorphic.** One principal table with `kind ∈ {user, agent}` keeps joins clean into audit/attribution. Avoids the shadow-user anti-pattern seen in other platforms.
- **Versioning ≠ snapshots.** Versioning is per-doc, user-facing time travel. Snapshots are operator-facing point-in-time disaster recovery. Two different storage paths, two different APIs.
- **Public publish strips internal elements.** Implies per-block visibility flags, in the schema from day one — not a render-time best effort.
- **Agents-as-users is literal.** Rate limits, audit, undo, attribution, token rotation, trash recovery — every control surface a human has, an agent has an equivalent to. If a design treats them as second-class, it is wrong.

## Hard invariants (to encode as property tests in Phase 3)

1. `md → crdt → md` is a fixed point for any canonical Markdown input.
2. Any set of concurrent edits from any mix of human/agent clients converges to the same state across replicas.
3. Every mutation produces exactly one audit entry; the audit log alone can reconstruct the final state from the initial state.
4. Every capability exists on every surface it is type-compatible with. Contract tests enforce the matrix; unchecked cells fail CI.
5. Permission checks live in the capability layer. No surface bypasses them; no surface re-implements them.
6. Soft-deletes are recoverable via a first-class capability. Hard-deletes are separate, audited, and never silent.

## Explicit assumptions (revisit in ADRs, not settled)

- **TypeScript is the default hypothesis, not a decided answer.** Go or Rust may win if the single-binary deploy target dominates. The language ADR will challenge the default, not rubber-stamp it.
- **MCP needs both stdio and HTTP-SSE transports.** The capability router cannot bake in one transport.
- **Postgres at scale, SQLite for single-node self-hosts.** Some features may degrade gracefully on SQLite; acceptable if documented. The dual-backend constraint probably rules out Prisma.
- **AGPL-3.0 is the leading license default** (protects hosted-service commercialization, keeps community forks legit). Apache-2.0 is the alternative if contributor reach matters more than protection. License ADR decides.
- **We are not building LLM orchestration.** Agents are authenticated API clients with identities. Model intelligence runs elsewhere.

## Open questions (do not block Phase 1)

- ~~**Scale target.**~~ **Resolved 2026-04-17:** production target 500–1,000 users per instance minimum, design headroom for 10,000. Postgres is the production target; SQLite mode is for small-team pilots / dev / home-lab only. See [ADR 0007](adr/0007-database-strategy.md).
- **Commercial arm.** OSS-only or OSS + hosted? Changes license calculus and which extension points are baked in. **Still open.**
- ~~**Sub-block ACLs.**~~ **Resolved 2026-04-17:** deferred; permission model reserves an `AccessPath.selector` field so sub-block granularity is a clean additive change. See [ADR 0015](adr/0015-permission-enforcement.md).
- **Agent offline-edit.** Do agents get offline/reconcile semantics, or assumed always-online? Default: always-online. **Still open.**

I will propose answers in the relevant ADRs; Nomi overrides any of them there.

## Approach

**Phase 1 research fan-out:** parallel subagents, one per decision area (CRDT, editor, transport, language, DB, search, MCP, SSO, TLS, deploy, license, UI framework). Each returns a short memo with citations. I synthesize into ADRs in rough dependency order: language → CRDT → editor → UI framework → transport → DB → search → MCP → SSO → TLS → deploy → license.

**Phase 2** starts only after the ADR set is committed and red-teamed.

**Harness before features.** No slice code lands until the verification stack (types, lint, unit, property, integration, contract, e2e, smoke deploy, observability) is green on a trivial "create doc, read doc" slice across all four surfaces.

## Self-critique (red-team pass)

- *"Full parity" is easy to say, hard to enforce.* Making it concrete: a capability matrix in `docs/architecture/` with per-surface coverage, enforced by contract tests. Unchecked cell = CI fails.
- *Invariant list is silent on performance and cost.* Intentional for Phase 0; these are Phase 3 harness concerns.
- *Conflation of "blocks" with "Markdown AST nodes."* This is a real architectural fork: Notion-style block model (blocks are first-class, Markdown is a serialization format) vs. CommonMark-style (Markdown AST is the model). Promote to its own ADR in Phase 1.
- *Background workers not addressed.* Webhooks, notification fanout, embedding generation, search indexing — a job queue is needed. Quietly assumed; call it out in Phase 2 architecture.
- *"curl | sh" under-weighted in language defaults.* Single-binary deploy meaningfully pushes toward Go/Rust. The language ADR must confront this explicitly, not treat TS as inertia.
- *Contract-test parity is a lot to maintain if the capability surface grows fast.* Mitigation: generate all four surface adapters from a single capability schema; contract tests then assert generated surfaces match the schema. If we hand-write adapters, the test burden will drag on velocity.

## First moves
1. Commit this brief, `AGENTS.md`, `README.md`, `.gitignore`, empty `docs/adr/`.
2. Fan out Phase 1 research in parallel. (This turn.)
3. Synthesize ADRs as memos return.
4. Red-team the ADR set before Phase 2.
