/**
 * The browser's same-origin typed-RPC client (ADR 0030 / ADR 0035 §2).
 *
 * `baseUrl: ""` (empty string, NOT `"/"`) makes every call a relative path —
 * `/infra/whoami`, `/auth/*`, … — so it hits the page origin in production and
 * Vite's dev-proxy in development (vite.config.ts reverse-proxies the
 * `RESERVED_API_PREFIXES` to the trunk, so the browser sees one origin and
 * ADR 0030's `SameSite=Lax` cookie model holds identically in dev and prod).
 * An absolute origin would re-introduce the CORS the same-origin model avoids.
 *
 * No `auth` resolver: `createHttpClient` already forces `credentials: "include"`
 * (http-client.ts), so the Better Auth session cookie rides along automatically.
 * The `auth()` hook is only for bearer/PAT callers (CLI, agents) — the browser
 * authenticates by cookie, not by header.
 */
import { createHttpClient } from "@editorzero/api-client";

export const apiClient = createHttpClient({ baseUrl: "" });
