# ADR 0015 — Permission enforcement: capability-layer + Postgres RLS

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Red-team (#9, #13) flagged that "permission checks centralized in the capability layer" is underspecified. Middleware-level checks are bypassable by any internal caller (background job, MCP tool, webhook handler) that forgets to invoke the middleware. For a platform where AI agents are peer principals and workspace/tenant isolation is first-order, the check must be at the point of data access — not at an HTTP route boundary that internal code can sidestep.

## Options considered
- **Middleware-only.** Every HTTP route passes through an auth middleware that resolves the principal + checks a permission. Any non-HTTP caller bypasses it.
- **Capability-layer enforcement only.** Every capability (ADR 0009) has declared `requires: ["perm:..."]`; the capability dispatcher checks before calling the handler. Every surface (API/CLI/MCP/UI) invokes capabilities, so the check is unavoidable via capabilities. But: direct DB reads by ad-hoc code (e.g., a background job) could still bypass.
- **Row-level security (RLS) at the DB layer.** Postgres has native RLS policies; SQLite has none but we can wrap Kysely with a guard that forbids un-tenanted queries.
- **Layered: capability dispatch + tenant-aware query wrapper + Postgres RLS.**

## Decision
**Three-layer enforcement, each independently sufficient for the common case:**

### Layer 1 — Capability dispatch
Every capability (ADR 0009) declares `requires`. The dispatcher resolves the current `Principal` (ADR 0016), evaluates permissions against the capability's `requires`, and calls the handler. No surface (API, CLI, MCP, Web UI) invokes handlers directly.

- Resolved permissions come from role defaults (workspace role) < space defaults (per-workspace role overrides) < doc overrides (per-doc ACLs), per the permission model (written into `docs/architecture.md` in Phase 2).
- Capability metadata includes whether the capability is human-only, agent-allowed with scope X, or admin-only. Agent-kind principals are rejected from human-only capabilities at dispatch.

### Layer 2 — Tenant-aware query wrapper (Kysely)
Every Kysely `query` constructed against a tenant-scoped table (`docs`, `blocks`, `comments`, `audit_events`, etc.) goes through a `TenantScopedDb` wrapper that injects a `workspace_id = :ctx.workspace_id` predicate unconditionally. Attempting to build a tenant-scoped query without a `TenantContext` throws at query build time (TypeScript type error AND runtime assertion).

- The `TenantContext` is carried through request-scoped async storage (Node `AsyncLocalStorage`) set by the capability dispatcher after permission check. Any code path that escapes the capability dispatch (ad-hoc script, one-off admin tool) must construct its own `TenantContext` — there is no default-fall-through.
- Ops / super-admin code uses a distinct `OpsDb` that does not auto-inject predicates; its use sites are audited.

### Layer 3 — Postgres Row-Level Security (Postgres mode only)
On Postgres, RLS policies on every tenant-scoped table enforce the same `workspace_id = current_setting('app.workspace_id')` predicate at the database itself. The capability dispatcher sets the session variable on checkout. **Even if Layer 1 and Layer 2 were both bypassed, RLS is the last line of defense.**

SQLite has no RLS; we rely on Layer 2 and the conformance test suite (ADR 0007) to catch divergence.

### What passes through
- A malicious or buggy background job cannot read cross-tenant data even if it forgets to set a `TenantContext` — query construction throws.
- An MCP tool handler cannot execute without a permission check — it goes through the capability dispatcher.
- A raw SQL query via `OpsDb` is deliberate, audited (OTel span + audit row), and rare.

## Consequences
- Permission checks cannot be bypassed per-surface — every surface calls through capability dispatch.
- Tenant isolation is enforced at query construction AND, in Postgres, at the database.
- We pay an implementation cost: every tenant-scoped query goes through the wrapper; `OpsDb` use sites require review.
- SQLite mode does not have RLS as a backstop; Layer 2 is the floor. The ADR 0007 conformance suite includes cross-tenant leak tests to catch bugs.
- Contract tests assert: for every capability, the matrix (no-principal, wrong-workspace-principal, correct-workspace-principal, agent-principal-with-scope, agent-principal-without-scope) produces the expected allow/deny outcome.

## Revisit triggers
- A cross-tenant data leak bug occurs despite three layers — post-mortem identifies the layer that failed and we strengthen it.
- SQLite RLS becomes available via an extension we trust.
- We need sub-block ACLs (spec open question); the permission-resolution tree grows; `requires` gains complexity.
