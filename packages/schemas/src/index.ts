/**
 * `@editorzero/schemas` — the single source of wire + internal contracts
 * for every capability (ADR 0034). Surfaces (API routes, CLI, MCP),
 * capabilities, and tests all derive their types from these schemas;
 * the `.transform()` on each field carries the wire↔branded shape change
 * so there is exactly one definition, not a wire copy and an internal copy.
 *
 * The root entry re-exports the shared primitives. Per-capability schemas
 * are imported by subpath — `@editorzero/schemas/doc/create` — so each
 * file is independently importable (no central barrel to serialise edits
 * through). Add a capability by creating `src/<domain>/<cap>.ts`; no edit
 * here is required.
 */

export * from "./shared/audit";
export * from "./shared/fields";
export * from "./shared/grant";
export * from "./shared/ids";
export * from "./shared/principal-ref";
