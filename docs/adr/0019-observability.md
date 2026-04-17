# ADR 0019 — Observability: OpenTelemetry + Prometheus + admin dashboard

**Status:** Accepted (post-red-team)
**Date:** 2026-04-17
**Deciders:** @numman

## Context
Red-team (#25) flagged: a senior reviewer will ask where the SLOs are, what the golden signals per surface are, what the tracing story is, how a self-hoster debugs a slow query without shell access. OTel SDK + `/metrics` + built-in admin dashboard is table stakes. The meta-prompt also requires: OpenTelemetry traces, Prometheus metrics, structured logs, from day one.

## Decision

### Instrumentation: OpenTelemetry SDK throughout

- **Node backend:** `@opentelemetry/sdk-node` auto-instrumenting Hono, Hocuspocus, Kysely, Better Auth, ONNX runtime, pg-boss.
- **Web UI:** `@opentelemetry/sdk-trace-web` for RUM on the app route; page-load metrics on the public route (sent only with consent).
- **CLI:** `@opentelemetry/sdk-node` with OTLP export disabled by default; enable via `EDITORZERO_OTEL_EXPORTER_URL`.
- **Capability dispatcher** (ADR 0015) emits a span per capability invocation with `capability.id`, `principal.kind`, `principal.id`, `workspace.id`, `outcome`. Every capability gets the same span shape — one pattern to learn, regardless of surface.

### Golden signals per surface

| Surface | Latency | Traffic | Errors | Saturation |
|---|---|---|---|---|
| HTTP API | p50/p95/p99 per capability | req/s per capability | 4xx/5xx rates | Node event-loop lag, DB pool utilization |
| Hocuspocus (real-time) | update-apply latency p95, ack RTT | connected sessions, updates/s | failed auths, rejected updates | in-memory Y.Doc count, memory per doc |
| MCP | tool-call duration p95, stream lag | tool calls/s, active sessions | auth failures, tool errors | DCR client count, session count |
| CLI | command duration p95 | commands/s | exit codes != 0 | (client; no saturation) |
| Search | query latency p95, nDCG@10 (ADR 0008) | queries/s | timeouts | index size, embed queue depth |
| Jobs | job age oldest pending, completion latency | jobs/s by queue | failure rate by queue | queue depth by queue |

### Prometheus metrics endpoint

- `/metrics` on the app serves Prometheus-format metrics (OTel → Prometheus via the OTel exporter).
- Self-hosters scrape with their own Prometheus; or set `EDITORZERO_OTEL_EXPORTER_URL` to push to any OTLP endpoint (Honeycomb, Grafana Cloud, Datadog OTLP, SigNoz, Uptrace, local otel-collector).

### Structured logs

- `pino` with OTel bridge — logs carry `trace_id` and `span_id` matching traces.
- Log levels: `error`, `warn`, `info`, `debug`. Default `info` in prod, `debug` in dev.
- All log lines JSON, with `workspace_id`, `principal.kind`, `principal.id` where relevant.

### Admin dashboard

- At `/admin/observability` for workspace admins and operators.
- Built-in panels (no Grafana required for the basics):
  - Request rate + p95 latency per capability (sparkline).
  - Hocuspocus sessions + update rate.
  - Queue depth by queue name.
  - Doc count, block count, embedding index size, search index size.
  - Error events (last 50, filterable by principal).
- Uses the Prometheus data the app exposes locally; no external dependency.
- For operators wanting more, Grafana dashboards committed in `ops/grafana/` pointing at the same metrics.

### SLOs (operator-declared, default)

- API p95 latency: < 200 ms (reads), < 500 ms (writes).
- Hocuspocus update-to-ack p95: < 100 ms in-cluster, < 300 ms cross-region.
- Error rate: < 0.1% of requests.
- Search query p95: < 250 ms.
- Job oldest-pending age: < 30 s for hot queues (email, webhooks); < 5 min for cold (embedding, import).

Shipped as defaults; operators can tune. Breach triggers a warning badge on the admin dashboard.

### Self-host debugging primitives

A self-hoster without shell access can:
- See slow queries via the admin dashboard's query-span panel.
- Export a 5-minute trace window as a zip for bug reports.
- Run `editorzero diagnose` via CLI to collect logs + metrics snapshot.

## Consequences
- Every subsystem emits OTel spans; debugging a production issue follows the span tree.
- Operators do not need external infrastructure to get basic observability.
- Operators with existing OTel/Prom stacks plug in via standard configuration.
- Observability data carries workspace + principal context, so a multi-tenant support ticket narrows quickly.
- OTel instrumentation adds overhead; budget: < 3% CPU, < 50 MB RAM. Measured in Phase 3 harness.

## Revisit triggers
- Built-in dashboard becomes significant UI work relative to defer-to-Grafana approach.
- OTel overhead exceeds budget under load.
- A self-hoster support pattern reveals a missing telemetry dimension — add.
