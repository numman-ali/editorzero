/**
 * `@editorzero/api-server` — public barrel.
 *
 * Exports the Hono trunk (`app`) + its RPC type (`AppType`). The type
 * is the contract `packages/api-client` and every typed-client call
 * site (frontend, tests, server-to-server route composition) binds
 * against via `hc<AppType>`.
 */

export { type AppType, app } from "./app";
