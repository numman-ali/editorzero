/**
 * `ApiEnv` — the single Hono `Env` shared across the whole trunk.
 *
 * Route modules type against this env (or a subset assignable to it);
 * they do **not** invent their own. Reason: `Hono.route()`
 * preserves Schema in its return type but does not merge sub-app
 * `Env` back into the parent, so per-route-module envs fragment the
 * `c.var` surface at composition time (the middleware that set
 * `c.var.principal` on route A wouldn't be in route B's env
 * otherwise).
 *
 * `hc<AppType>` only extracts the Schema, not `Env` — so every
 * variable named here is server-internal. Adding a new variable is
 * fine; removing one is a breaking change for every handler that
 * reads it.
 *
 * ### Variables
 *
 * - `principal: Principal` — resolved once per request by the auth
 *   middleware (`src/middleware/principal.ts`). Either a `UserPrincipal`
 *   (browser session or human PAT) or an `AgentPrincipal` (API key or
 *   delegated agent-auth token). Capability routes read this directly
 *   off `c.var`; the dispatcher requires it on every `DispatchInvocation`.
 *   **Non-optional.** A route that mounts without the principal
 *   middleware cannot legally run a capability; its absence is a
 *   composition-time bug, not a runtime condition. Public routes (like
 *   `/infra/health`) run outside the chain that sets this variable —
 *   they type against a subset of `ApiEnv` that doesn't read it, or
 *   they run on a sub-tree that doesn't include the principal mw.
 *
 * - `dispatcher: Dispatcher` — a process-scoped `Dispatcher` returned
 *   by `createApiDispatcher({...})` (`src/composition/
 *   createApiDispatcher.ts`). The dispatcher owns the single
 *   orchestration path (architecture.md §6.1); capability routes
 *   exclusively invoke capabilities through it. Holding it on
 *   `c.var` rather than importing it at module scope makes the route
 *   handler independent of the composition root — tests can swap a
 *   fixture dispatcher in via `createDispatcherMiddleware({
 *   dispatcher: testDispatcher })` without rewiring imports.
 *
 * Future variables (deferred until their slice lands):
 *
 *   - `tenant: TenantContext` — tenant-scope middleware that reads
 *     `workspace_id` from `principal` and threads it through
 *     `AsyncLocalStorage`. Today the dispatcher's `runInWriteTx` /
 *     `runRead` derive tenant from `principal.workspace_id`
 *     directly, so this var is not needed until a handler needs
 *     tenant access outside a dispatch call.
 *   - `rateLimit: RateLimitBudget` — remaining-budget info exposed to the
 *     current request handler. Enforcement itself lives in the
 *     `withRateLimit` composition wrap (ADR 0044 Decision 6), which
 *     refuses pre-dispatch and hands the retry hint back on the
 *     `RateLimitError`; surfacing live budget on the request context is a
 *     separate, deferred nicety — not built this slice.
 */

import type { Dispatcher } from "@editorzero/dispatcher";
import type { Principal } from "@editorzero/principal";

export interface ApiEnvVariables {
  readonly principal: Principal;
  readonly dispatcher: Dispatcher;
}

export interface ApiEnv {
  readonly Variables: ApiEnvVariables;
}
