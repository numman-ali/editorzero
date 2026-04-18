/**
 * `@editorzero/dispatcher` — the single orchestration path between
 * surface adapters and capability handlers (architecture.md §6.1).
 *
 * Public surface:
 *  - `createDispatcher(deps)` — returns a `Dispatcher` with a
 *    `dispatch` fn that runs the full pipeline (parse → gate → invoke
 *    → parse → audit).
 *  - `scopeOnlyGate()` — default `PermissionGate` for unit tests and
 *    the pre-db slice. A `workspaceAwareGate` composes behind the same
 *    interface when `@editorzero/db` lands.
 */

export type {
  CapabilityContextExtras,
  Dispatcher,
  DispatcherDeps,
  DispatchInvocation,
} from "./dispatcher";
export { createDispatcher, TenantMismatchError } from "./dispatcher";
export type { CapabilityGateMeta, GateResult, PermissionGate } from "./gate";
export { AGENT_SCOPE_TIERS, scopeOnlyGate } from "./gate";
