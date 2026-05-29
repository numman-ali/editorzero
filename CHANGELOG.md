# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Phases 0–2** — Phase 0 brief + invariants; 26 ADRs (0001–0026); the Phase 2 end-to-end architecture (`docs/architecture.md`), hardened across four red-team passes (F1–F97).
- **Capability kernel + registry** — `@editorzero/capabilities` with 24 capabilities across `doc.*`, `collection.*`, `workspace.*`, and `audit.*`; branded IDs, scopes, and the dispatcher permission gate.
- **Storage** — dual SQLite + Postgres drivers via Kysely, with a dual-backend conformance harness (ADR 0023).
- **Auth** — Better Auth spine (credentials + sessions) with editorzero-owned `workspace_members` and a role-resolving principal layer (ADR 0024).
- **Surface adapters** — a Hono API trunk with typed `hc<AppType>` RPC; a compiled `ez` CLI (ADR 0025); and an MCP server mounted at `/mcp` (ADR 0026). Every capability declares all four surfaces; the Web UI app is not yet built.
- **Verification** — unit, property (CRDT convergence, Markdown fidelity, write-path atomicity), integration (real SQLite + Postgres), and e2e lanes wired into pre-commit / pre-push hooks.
