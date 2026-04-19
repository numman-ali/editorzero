/**
 * `@editorzero/api-client` — public barrel.
 *
 * Exports the two typed-RPC client factories (ADR 0021 §Mechanics):
 *
 *  - `createServerClient({ app, forwardHeaders })` — in-process via
 *    `app.request`, for Next Server Actions / RSC / vitest integration
 *    / server-to-server capability composition.
 *  - `createHttpClient({ baseUrl, auth })` — real fetch over TCP, for
 *    CLI + frontend + external consumers.
 *
 * Both return `hc<AppType>` shapes so every call site is identical at
 * the typed-RPC surface. Swapping between them is a composition
 * choice, not an API change.
 */

export { type ApiClient, createHttpClient, type HttpClientOptions } from "./http-client";
export { createServerClient, type ServerClient, type ServerClientOptions } from "./server-client";
