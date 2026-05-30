## 1. Purpose

Turn the 20 accepted ADRs into a system design that is:

- **Coherent** — every capability, table, surface, and test fits a single mental model.
- **Implementable** — Phase 3 can scaffold a monorepo and harness against this doc without further architectural argument.
- **Verifiable** — every hard invariant from AGENTS.md maps to a specific test in the verification stack.

Anything still open after this doc is listed in [§19 Open questions](19-open-questions.md#19-open-questions-carried).

This file mixes **target-state architecture** with **landed-status callouts**. Unless a paragraph explicitly says something is "currently landed", "open", "planned", or cites a concrete test/file as present evidence, read package inventories, surface adapters, and verification paths below as the intended architecture rather than a claim that the current tree already contains every listed package or harness. Phase-closure truth lives in `docs/continuation.md`, and the sections touched by P3.6+ call out their current status inline.

## 1.1 Design posture — engineering for coding agents

This repo is built to be **worked on by coding agents** (and disciplined humans) without regression, hallucination, or drift. The product is agent-native too — humans and AI agents are peer end-users of the platform — but that's a separate concern covered by the Principal model (§3.3, §8), `agentAllowed` capability metadata (§4), and the agent-first invariants in AGENTS.md.

The **engineering discipline** below is what keeps velocity high with a solo author + agent contributors:

> If a shape exists in two places, it's drift. Promote it to a primitive; derive the rest.
> If a layer boundary can be expressed in types, a lint rule, or a codegen check, it should be.
> If an invariant must always hold, a property test proves it — not a comment.

Operationalized throughout this doc:

- **Layered responsibilities** (§16): capability → dispatcher → service → repository → infrastructure. Each layer imports only downward. Enforced by architecture lint; an agent cannot accidentally reach through.
- **One zod schema per capability → every consumer.** HTTP route (`hono-openapi` validator, ADR 0029), OpenAPI, MCP tool schema, CLI parser, UI form validation, audit `input_hash`, contract tests — all read the same object. Hand-writing a second schema is forbidden.
- **Registry as the source of truth.** Surface adapters, contract-test matrix, OpenAPI, MCP tool list, permission matrix, rate-limit config, audit shape — all derived from `packages/capabilities`. Hand-written glue that could be generated is the anti-pattern.
- **Typed primitives over stringly-typed anything.** Branded IDs (`WorkspaceId`, `DocId`, `BlockId`, `CapabilityId`, `SessionId`, `TokenId`, `AgentId`, `UserId`), string-literal unions (`Scope`, `CapabilityCategory`, `FidelityTier`, `QueueName`), discriminated unions (`Principal`, `AuditEffect`, `JobPayload`, `Block`). A misused identifier is a compile error, not a test failure.
- **Type-level guarantees over runtime guards.** `TenantScopedDb` makes an un-tenanted query a build-time error. `ctx.transact` is the only way to reach a Y.Doc — no raw Hocuspocus in handlers. A capability handler that skips audit can't compile (the context requires one).
- **Semantic naming mirrors capability IDs.** `capabilities/doc/update.ts` implements `doc.update`. `capabilities/doc/update.unit.test.ts` sits next to it. When the surface adapters and contract matrix land, cross-surface contract/integration coverage derives from that same name. An agent searching for "where do I edit doc update logic" finds one place.
- **Declarative over imperative.** Capabilities, block specs, fidelity tiers, job definitions, mirror configs, permission grants — all declarative data. The framework executes; product code declares.
- **Codegen at build, property tests at commit.** Derived artifacts (OpenAPI spec, Kysely types from Atlas DDL, CLI parsers, MCP tool registrations) are generated + committed + diff-reviewable. Invariants that must always hold (Markdown round-trip, CRDT convergence, audit replay, permission three-layer, inverse-restore) are property-tested every commit.
- **Tests sized to the guarantee they prove.** Unit for pure logic, integration against real SQLite + Postgres, property for invariants, contract for surface parity, E2E for user paths + a11y. Each layer has its own test harness; a regression fails at the smallest scope that can catch it.

The specifics of the layering, the codegen inventory, the lint rules, and the test harness layout are in **[§16 Engineering primitives for agentic workflows](16-engineering-primitives-for-agentic-workflows.md#16-engineering-primitives-for-agentic-workflows)**. The architecture sections between now and there name the product-side typed primitives as they appear.
