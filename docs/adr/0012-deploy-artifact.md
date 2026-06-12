# ADR 0012 — Deploy artifact: docker-compose primary + Bun-compiled CLI binary

**Status:** Accepted (post-refresh; CLI framework + agent-output contract refined by [ADR 0021](0021-surface-transport-topology.md), 2026-04-18; server artifact updated to the Hono-trunk topology by [ADR 0027](0027-web-ui-topology.md), 2026-05-30)
**Date:** 2026-04-17 (v2)
**Deciders:** @numman

> **See [ADR 0021](0021-surface-transport-topology.md) before editing the CLI section.** It names the CLI framework (`citty`), commits the CLI to being an HTTP client of the Hono trunk via `hc<AppType>`, adopts [AXI](https://github.com/kunchenguid/axi) as the agent-output contract (stdout format — TOON vs JSON vs alternatives — deferred to eval), and binds the session-hook self-install behaviour for Claude Code + Codex.

> **Amendment (2026-06-12, first shipped artifact — `Dockerfile` + `docker-compose.yml` + `scripts/smoke-deploy.sh`).** The sketch below predates the shipped config/auth surface; where they differ, the shipped shape governs:
>
> - **Env names** — `DATABASE_URL` (a SQLite file path or `:memory:`; the composition root is SQLite-only today, a Postgres URL fails loud per ADR 0007-deferral), `EDITORZERO_PUBLIC_ORIGIN`, `BETTER_AUTH_SECRET` (required, no baked default), `EDITORZERO_SPA_DIST` (points the trunk at the baked SPA bundle — `attachSpa`, ADR 0027/0035). The sketch's `EDITORZERO_DB` / `EDITORZERO_EMBED_MODE` never existed.
> - **Health check** lives at **`/infra/health`** (ADR 0025 prefix discipline), not `/health`.
> - **First boot** — the sketch's "signed one-time installer URL (Pocketbase pattern)" is **superseded** by the registration gate (ADR 0030/0041): `EDITORZERO_REGISTRATION_MODE=first-user` (default) makes the first `/auth/sign-up/email` the audited genesis bootstrap and closes self-registration after it. No separate installer flow.
> - **Migrations on startup** — `getApiApp` runs `ensureSchema` + Better Auth migrations at boot; Atlas CE remains the future dual-backend story, not a container entrypoint step.
> - **Server artifact internals** — the runnable entrypoint is the **esbuild server bundle** (`apps/server/scripts/bundle.mjs`; `module: Preserve` dists are extensionless → unrunnable under plain node), with `better-sqlite3` external resolved from a `pnpm deploy --prod --legacy` pruned closure. Same bundle the e2e lane boots — the artifact is continuously exercised.
> - **Compose** uses `build: .` until release engineering publishes `editorzero/editorzero:TAG` images; the smoke lane is `pnpm smoke:deploy` (manual — an image build per push is too heavy for the pre-push hook; revisit at the phase boundary).

## Context
v1 honestly declared "docker-compose, full stop" because the Bun `--compile` single-binary route was 2026-young with native-dep pitfalls. The refresh confirmed Bun's server runtime is still not boring (ADR 0002) but revealed that **`bun build --compile` is production-grade for CLI distribution** — cross-compilation to Linux/macOS/Windows amd64/arm64, fast cold starts, embedded assets and SQLite, auto-loaded env. That's a real single-binary win for the `editorzero` CLI surface.

## Decision
**Primary server artifact: `docker-compose.yml`.** **Secondary CLI artifact: Bun-compiled cross-platform binaries.**

### Server artifact (primary)

`docker-compose.yml` with sane defaults. Single-host default: one service running the **Hono trunk** ([ADR 0027](0027-web-ui-topology.md)) — Vite/React SPA assets + event-rendered static published HTML + embedded Hocuspocus (ADR 0006), over SQLite. Advanced services (Postgres, Caddy, Redis) are opt-in compose additions.

```yaml
services:
  app:
    image: editorzero/editorzero:TAG
    ports: ["3000:3000"]
    volumes: ["./data:/data"]
    environment:
      EDITORZERO_DB: sqlite:///data/editorzero.db
      EDITORZERO_EMBED_MODE: disabled
```

- SQLite file under `./data/`. Attachments under `./data/attachments/`. CRDT state under `./data/docs/`. Caddy state (when enabled) under `./data/caddy/`.
- First boot prints a signed one-time installer URL (Pocketbase pattern) to create the initial superuser.
- Backup = `tar ./data/`.
- Health check at `/health`; graceful shutdown on SIGTERM.
- Migrations run on startup via Atlas CE (ADR 0007).

### CLI artifact (secondary)

`editorzero` CLI built with `bun build --compile`:
- **Targets:** `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`.
- **Binary size:** ~60–85 MB per target.
- **Startup:** ~110 ms cold.
- **Embedded:** `bun:sqlite` for local cache, SPDX license banners, asset fixtures.
- **Distribution:** published as release assets on GitHub, signed with cosign, checksummed. Installer curl script: `curl -fsSL https://editorzero.dev/cli.sh | sh`.
- **Scope:** the CLI is a thin client over the capability registry (ADR 0009 / 0015). It does not embed the server. Users authenticate with a PAT or agent token against a remote editorzero instance.

The CLI is where the "single binary" aesthetic lives honestly — short-lived, stateless, native-dep-light. The server stays Node 22 LTS on Docker because that's where the stability premium pays off (ADR 0002).

### What we do not ship in v1
- Single-binary server. Multi-process reality (app + optional Postgres + optional Caddy + optional Redis) is honest.
- OS packages (community can package from the Docker image).
- Nix flake (community-driven).
- Windows-native server; Windows users run via Docker Desktop / WSL2. Windows CLI binary is first-class.

### Release artifacts per version
- Docker image: `editorzero/editorzero:TAG`, `linux/amd64` + `linux/arm64`, multi-arch manifest.
- `docker-compose.yml` templates: `default`, `with-postgres`, `with-postgres-caddy`, `with-postgres-caddy-redis`.
- CLI binaries: 5 target tuples, checksummed and cosigned.
- Sample `systemd` unit for podman-users.
- CHANGELOG entry + release notes.

### Upgrades
- Compose: `docker compose pull && up -d`. Migrations run on startup.
- CLI: `editorzero self-update`, or re-download.

## Consequences
- Docker-first server is honest; no "single binary" marketing against a multi-process reality.
- CLI-as-single-binary recovers the `curl | sh` aesthetic for the user's client-side experience.
- Release engineering cost bounded: one Docker image + five CLI target tuples.
- Cross-platform CLI handled; server cross-platform handled by Docker.
- CLI binary build happens in CI (Bun builder); adds a build matrix but no new runtime dep.

## Revisit triggers
- Bun ships a formal LTS policy AND issue #29302 closes AND `onnxruntime-node` becomes first-class on Bun → reconsider Bun server runtime (ADR 0002) which would open a single-binary server route.
- A class of CLI native-module incompatibility that Bun cannot absorb.
- Compose onboarding friction becomes a documented cliff for our target users.
