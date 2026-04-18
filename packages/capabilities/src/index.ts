/**
 * Capability kernel — public barrel (architecture.md §4, §16.4).
 */

export type {
  AgentAllowance,
  AnyCapability,
  Capability,
  CapabilityAudit,
  CapabilityContext,
  Deprecation,
  Logger,
  RateLimit,
  TenantScopedDbHandle,
  Tracer,
  TracerSpan,
} from "./kernel";
export type { CapabilityMap, Registry, RegistryLookupError } from "./registry";
export { createRegistry } from "./registry";
