## 14. OpenAPI surface (derived, not authored)

Per Nomi's directive + ADR 0009: OpenAPI is **generated at runtime** from the capability registry, not hand-authored.

### 14.1 Generator

```
packages/api-server/src/openapi.ts
  → iterate capabilities
  → for each capability where surface includes HTTP:
      emit a hono/factory route (code-first; ADR 0029) via hono-openapi's
        describeRoute + validator — method, path, security (scopes),
        request schema, response schemas
  → expose:
      GET /api/v1/openapi.json   (live generated spec)
      GET /api/v1/docs           (Scalar / Rapidoc viewer)
```

### 14.2 Drift detection

A CI contract test snapshots the generated spec to `packages/api-server/openapi.snapshot.json`. A PR that changes the spec without updating the snapshot fails. Intentional changes commit the new snapshot. This gives us the one thing a static spec gives (diff-review of breaking changes) while the source of truth stays in code.

### 14.3 Security schemes

- `sessionCookie` — Better Auth session, browsers (same-origin fetch from the Vite SPA; `SameSite=Lax`, ADR 0030).
- `bearerToken` — API keys (human PAT) and agent API-keys (`@better-auth/api-key`).
- `oauth2` — OAuth 2.1 with DCR + PKCE S256; scopes from capability `requires` vocabulary.

### 14.4 Endpoints outside the registry

Thin pass-throughs, all covered by other ADRs:
- `POST /api/auth/*` — Better Auth mount.
- `GET /.well-known/oauth-protected-resource` — RFC 9728 (ADR 0009).
- `GET /.well-known/oauth-authorization-server` — OAuth discovery.
- `GET /metrics` — Prometheus.
- `GET /api/healthz` — health.
