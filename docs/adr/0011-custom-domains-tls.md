# ADR 0011 — Custom domains and TLS: Caddy sidecar with allow-listed on-demand TLS

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Users CNAME a custom domain to our deployment for published docs. We need dynamic per-domain cert provisioning without restart, HA-friendly cert storage, abuse gating, HTTP-01 and DNS-01 challenge support, and graceful renewal. Backend runtime is Node (ADR 0002); there is no in-process ACME library of CertMagic's quality in the JS ecosystem.

Red-team (#12) flagged on-demand TLS as a tenant-enumeration and cert-exhaustion vector.

## Options considered
- **Caddy as a reverse-proxy sidecar** — CertMagic under the hood; on-demand TLS with an `ask` endpoint hitting our backend; pluggable cert storage.
- **CertMagic embedded** — only natural in Go; not a fit for a Node backend.
- **Traefik** — no on-demand issuance for unknown domains.
- **node-acme-client / Greenlock** — Greenlock unmaintained; node-acme-client is too low-level.

## Decision
**Caddy as reverse-proxy sidecar**, driven by its admin API, with strict on-demand TLS gating.

### Threat model and mitigations (red-team #12)

- **Domain allow-list via `ask`.** Caddy's on-demand TLS `ask` endpoint points to our backend `GET /internal/tls/ask?domain=X`. Our backend responds `200` iff `X` appears in `custom_domains` with `status = 'verified'` (verified via DNS TXT challenge we run ourselves before accepting the CNAME). Unknown or unverified domains return `403` → Caddy declines the handshake. This prevents an attacker from triggering ACME issuance by pointing any DNS record at our IP.
- **Per-tenant issuance cap.** A tenant may register ≤ 20 custom domains total and issue ≤ 5 new certs per day across them. Hits are rate-limited and logged; sustained breach flags the tenant for operator review. Caddy's built-in ACME rate-limit backoff is a second line of defense.
- **Cert storage cache.** Caddy reads the cert store on every TLS handshake. In HA mode with the Postgres storage plugin, naive reads put cert lookups on the DB hot path. We configure Caddy with its local-disk cache on top of Postgres storage so steady-state is disk reads; only new-cert-issuance and cross-node replication hit Postgres.
- **Challenge types.** HTTP-01 by default; DNS-01 for tenants that want wildcards (requires them to configure a DNS provider).
- **TLS-ALPN-01** enabled for better captive-portal / load-balancer compatibility.

### Deploy modes

- **Default self-host (no custom domains):** Caddy is optional. App binds directly with TLS delegated to the environment (reverse proxy, load balancer, local dev plaintext).
- **Custom-domain deployment:** Caddy in the docker-compose graph, cert storage on local disk (single-node) or Postgres (HA). Admin API is network-isolated to localhost.

## Consequences
- One extra process when custom domains are enabled; transparent under `docker compose up`.
- Native, battle-tested ACME automation; we do not re-implement ACME.
- Allow-listed on-demand TLS closes the hyperscaler-scanning failure class.
- Tenant domain verification happens before Caddy is ever asked — CNAME without TXT-verify gets you nothing.
- Observability: cert issuance, renewal, and `ask` rejections emit OTel spans (ADR 0019).

## Revisit triggers
- A Node-native rustls-acme-grade library appears with HTTP-01 + DNS-01 + on-demand issuance + pluggable storage.
- Caddy admin-API breaks compatibility in a version we cannot pin around.
- An abuse class the `ask` allow-list + rate caps cannot mitigate; introduce stricter per-tenant issuance policy.
