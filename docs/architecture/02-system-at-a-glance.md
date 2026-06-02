## 2. System at a glance

```
              ┌───────────────────────────────────────────────┐
              │                 Clients                       │
              │   Web UI (SPA)       CLI (bun)   MCP clients  │
              │                 HTTP API (any)                │
              └──────────────┬────────────────────────────────┘
                             │  OAuth 2.1 / API key / session
                             ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │                     Caddy sidecar (ADR 0011)                       │
  │   — TLS on-demand (allow-listed via `ask`); reverse-proxies to app │
  └──────────────────────────────┬─────────────────────────────────────┘
                                 ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │                    Node 22 LTS app process                         │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │ Hono trunk (top-level server) — serves SPA                   │   │
  │ │   / (SPA)   /p/[slug] (static)  /api · /auth · /mcp          │   │
  │ │   embedded Hocuspocus WS (one port)                          │   │
  │ └──────────────────────────────────────────────────────────────┘   │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │ Capability routes — OpenAPI from zod (one tuple)             │   │
  │ │   typed RPC via hc<AppType> (in-proc + HTTP)                 │   │
  │ └───────────┬────────────────────────┬─────────────────────────┘   │
  │             ▼                        ▼                             │
  │ ┌───────────────────────┐ ┌─────────────────────────┐              │
  │ │ Better Auth spine     │ │ Capability dispatcher   │              │
  │ │ (ADR 0010, 0016)      │ │ (ADR 0009, 0015)        │              │
  │ │ sso / oauth-provider  │ │  registry: Map<id,Cap>  │              │
  │ │ mcp / api-key         │ │  scope+rate+audit check │              │
  │ │ agent-auth / core     │ │  calls handler          │              │
  │ └───────────┬───────────┘ └────────────┬────────────┘              │
  │             │                          │                           │
  │             │   Principal (ADR 0016)   │                           │
  │             └───────────┬──────────────┘                           │
  │                         ▼                                          │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │  Capability handler                                          │   │
  │ │   loads live Y.Doc from Hocuspocus, or hydrates from         │   │
  │ │   doc_snapshots + doc_updates; binds BlockNoteEditor to the  │   │
  │ │   live Y.XmlFragment; one editor.transact() per mutation     │   │
  │ └───────────┬───────────────────┬──────────────────────────────┘   │
  │             ▼                   ▼                                  │
  │ ┌──────────────────────┐ ┌──────────────────────┐                  │
  │ │ Hocuspocus (ADR 0006)│ │ TenantScopedDb       │                  │
  │ │   WebSocket sync     │ │ (Kysely + ALS ctx)   │                  │
  │ │   onChange: durable  │ │ + tenant fuzzer      │                  │
  │ │   write to           │ │ (ADR 0015)           │                  │
  │ │   doc_updates        │ │                      │                  │
  │ └──────────┬───────────┘ └──────────┬───────────┘                  │
  │            │                        │                              │
  │            ▼                        ▼                              │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │                DB (SQLite | Postgres)                        │   │
  │ │   tenancy, principals, docs, blocks (projected),             │   │
  │ │   doc_snapshots, doc_updates, audit_events,                  │   │
  │ │   comments, attachments, search indexes, jobs,               │   │
  │ │   custom_domains, mirror_state, sessions/keys (Better Auth)  │   │
  │ └──────────────────────────────────────────────────────────────┘   │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │ Job queue (ADR 0014): pg-boss | custom SQLite                │   │
  │ │   embed, search-index, mirror.project_doc, reaper,           │   │
  │ │   webhook, email, compaction, dcr-cleanup                    │   │
  │ └──────────────────────────────────────────────────────────────┘   │
  │ ┌──────────────────────────────────────────────────────────────┐   │
  │ │ OTel SDK → Prometheus /metrics + OTLP (ADR 0019)             │   │
  │ └──────────────────────────────────────────────────────────────┘   │
  └────────────────────────────────────────────────────────────────────┘
       │                        │
       ▼                        ▼
  Redis (Postgres-HA only)   Object store (attachments, optional S3 mirror)
  (Hocuspocus fan-out)
```

**One process runs one binary's worth of subsystems.** SQLite mode drops Redis and uses the in-DB queue. Postgres mode adds Redis for Hocuspocus horizontal fan-out and pg-boss for jobs.
