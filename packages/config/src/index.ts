/**
 * `@editorzero/config` — typed runtime configuration + secret provider
 * contracts (architecture.md §16.12, F79).
 *
 * Boundary of the package: this is the ONLY place that reads
 * `process.env` in the monorepo. The planned `no-process-env` arch-lint
 * rule (§16.8) will enforce the boundary once `@editorzero/arch-lint`
 * ships (F89 — not yet implemented; review is the backstop today).
 * Downstream packages receive `RuntimeConfig` and provider instances;
 * they never touch environment variables.
 */

export type { ConfigIssue, RuntimeConfig } from "./env";

export {
  ConfigValidationError,
  loadEnvConfig,
  parseRuntimeConfig,
  runtimeConfigSchema,
} from "./env";
export type {
  RotatableSecretHandle,
  RotatableSecretKind,
  RotatableSecretProvider,
  SecretRef,
  SecretScope,
  Secrets,
  StartupSecretKind,
  StartupSecretProvider,
  VersionedSecret,
} from "./secrets";
