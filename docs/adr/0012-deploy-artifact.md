# ADR 0012 — Deploy artifact: docker-compose, full stop

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Target user: a non-expert self-hoster runs one command, lands at an installer URL, creates a superuser, and writes a doc. Meta-prompt accepts `docker compose up`. The original plan included a Bun `--compile` single-binary stretch goal; the red-team (#20) noted that with sqlite-vec, ONNX runtime, Caddy, and Hocuspocus pulling various native/out-of-process pieces, "single binary" would be aspirational and misleading. Disposition: drop the stretch; be honest.

## Options considered
- **docker-compose primary + single-binary stretch** (original) — promised more than we can deliver; invites "single binary" bug reports against a multi-process reality.
- **docker-compose primary, full stop** — honest; mirrors Plausible, Outline, Ghost, Bookstack, Directus, Vaultwarden.
- **OS packages** — delegated to community for v1.
- **Nix flake** — delegated to community.

## Decision
**`docker-compose.yml` is the primary and only officially-supported v1 artifact.**

### Default self-host (one command, zero configuration)

```yaml
services:
  app:
    image: editorzero/editorzero:1.0.0
    ports: ["3000:3000"]
    volumes: ["./data:/data"]
    environment:
      EDITORZERO_DB: sqlite:///data/editorzero.db
      EDITORZERO_EMBED_MODE: disabled   # keyword-only search by default
```

- SQLite file under `./data/`. Attachments under `./data/attachments/`. Hocuspocus doc snapshots under `./data/docs/`.
- First boot prints a signed one-time installer URL (Pocketbase pattern) to create the initial superuser.
- Backup = `tar ./data/`.
- Health check at `/health`; graceful shutdown on SIGTERM.

### Advanced configurations are opt-in compose services

- **Postgres mode:** add a `postgres` service; set `EDITORZERO_DB=postgres://...`.
- **Custom domains:** add a `caddy` service (ADR 0011).
- **Semantic search:** set `EDITORZERO_EMBED_MODE=local` (bge-small) or `=openai` (with key); adds ~200 MB RAM to app.
- **HA:** add Redis for Hocuspocus fan-out, point Caddy cert storage at Postgres.

### Embedded Web UI

Next.js app is built and embedded in the container image. Served directly by the app via Next's Node runtime. No CDN dependency; works air-gapped.

### Upgrades

`docker compose pull && up -d`. Migrations run on startup (Atlas, ADR 0007).

### Release artifacts per version

- Docker image: `editorzero/editorzero:TAG` for `linux/amd64` and `linux/arm64`.
- `docker-compose.yml` templates (default, with-postgres, with-postgres-caddy-redis).
- Checksums + cosign signatures.
- Release notes + CHANGELOG.
- Sample `systemd` unit for users who prefer running containers via podman + systemd.

### What we do not ship in v1
- Single binary (native deps + out-of-process components make it misleading).
- OS packages (community can package from the Docker image).
- Nix flake (community-driven).
- Windows-native; Windows users run via Docker Desktop / WSL2.

## Consequences
- Honest promise: `docker compose up`, one volume, data lives next to the compose file.
- Multi-service compose hidden behind defaults; users opting into Postgres/Caddy/Redis add services consciously.
- Release engineering cost is bounded: one Docker image, two architectures.
- Not shipping a binary means we cannot court users who refuse Docker; accept that trade-off for now.

## Revisit triggers
- Node SEA or Bun `--compile` matures to the point a real (not aspirational) single-binary is achievable with native deps — revisit as a community-requested stretch.
- Windows-native becomes a meaningful demand driver and WSL2 is insufficient.
- Compose onboarding data shows Docker install is a real cliff for our target self-hosters.
