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

// ── Capabilities (registered into `createRegistry` by a consumer) ─────────
//
// Capabilities export the `Capability<I, O>` value. Registration into a
// registry (which closes over their typed I/O) is the consumer's job —
// typically a central `registerAll()` in an app adapter. This keeps this
// barrel dependency-light and lets consumers choose which capabilities
// to include (e.g., an admin-only surface that omits public ones).

export { docCreate } from "./doc/create";
export { docGet } from "./doc/get";
export { docList } from "./doc/list";
