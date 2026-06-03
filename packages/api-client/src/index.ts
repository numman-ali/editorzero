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
 *
 * `ApiError` / `ApiErrorCode` (re-exported from `./api-error`) are the
 * client projection of the server's typed `{ error: code }` envelope —
 * the throwable every consumer rejects with, and the SSOT code union.
 */

export {
  API_ERROR_CODES,
  ApiError,
  type ApiErrorCode,
  isApiError,
  isApiErrorCode,
} from "./api-error";
export type { ApiClient } from "./client-type";
export { createHttpClient, type HttpClientOptions } from "./http-client";
export { createServerClient, type ServerClient, type ServerClientOptions } from "./server-client";
