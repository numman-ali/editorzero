/**
 * `ApiEnv` — the single Hono `Env` shared across the whole trunk.
 *
 * Route modules type against this env (or a subset assignable to it);
 * they do **not** invent their own. Reason: `OpenAPIHono.route()`
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
 * Currently empty because no middleware is mounted yet. Lands in
 * subsequent slices:
 *
 *   - `principal: Principal` — Better Auth middleware (ADR 0009 /
 *     0016).
 *   - `tenant: TenantContext` — tenant-scope middleware that pulls
 *     `workspace_id` from the `Principal` and sets the
 *     `WorkspaceScopingPlugin`-bound DB handle on the context.
 *   - `dispatcher: Dispatcher` — lazy per-request dispatcher or a
 *     process-wide one; decided at the dispatcher composition-root
 *     slice.
 */

// biome-ignore lint/suspicious/noEmptyInterface: starter shape; variables land in subsequent middleware slices. Keeping the declaration here rather than `type ApiEnv = {}` so the first middleware merge is a one-line `Variables: { principal: Principal }` edit, not a shape refactor.
export interface ApiEnvVariables {}

export interface ApiEnv {
  readonly Variables: ApiEnvVariables;
}
