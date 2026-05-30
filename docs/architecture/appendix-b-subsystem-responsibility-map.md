## Appendix B — Subsystem responsibility map

| Subsystem | Owns | Doesn't own |
|---|---|---|
| **Better Auth** | Credential lifecycle, OIDC/SAML/OAuth 2.1/DCR/PKCE, session storage, API keys, Agent Auth Protocol | Principal abstraction, per-tenant audience (we plumb), Hocuspocus session revocation, audit event model |
| **Hocuspocus** | WebSocket sync, `onChange` durability hook, `onStoreDocument` snapshot trigger, Redis fan-out | Auth (calls our middleware), capability dispatch, permissions |
| **BlockNote + Yjs** | Doc model, convergent editing, block IDs, ProseMirror integration | Persistence, permissions, audit |
| **Capability registry** | The shape of the capability set; single source of truth for the eventual surface adapters | Handler implementation (modules own those), auth |
| **Dispatcher** | Resolving principal, evaluating permissions, enforcing rate limits, writing audit | Holding state, executing business logic |
| **TenantScopedDb (Kysely)** | Unbypassable workspace predicate, type-time tenant safety | Table schema (Atlas owns migrations) |
| **Kysely + Atlas CE** | Query building, migrations, Postgres/SQLite dialect split | Relational modeling for Better Auth (adapter-owned) |
| **Job queue** | Durability, retry, backoff for async work | Handler logic |
| **Caddy sidecar** | TLS (on-demand, allow-listed via `ask`), reverse proxy | Auth decisions, routing past reverse-proxy |
| **OTel SDK** | Spans, metrics, logs with trace correlation | SLO policy (operator sets), alerting (Prometheus/external) |

---
