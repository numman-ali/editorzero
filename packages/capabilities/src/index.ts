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
  Tracer,
  TracerSpan,
} from "./kernel";
export type { Registry } from "./registry";
export { createRegistry, RegistryLookupError, registerCapability } from "./registry";
