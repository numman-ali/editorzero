/**
 * CLI-side capability registry (ADR 0021 §CLI generator).
 *
 * The CLI is a separate process from the server, so it needs its own
 * in-process registry to know which capabilities to expose as subcommands
 * — but the *membership* of that registry is no longer hand-maintained
 * here. It is the shared `createDefaultRegistry()` (the full capability
 * set, one place), so the server's registry (`getApiApp`) and the CLI's
 * cannot drift in which capabilities they include — the drift that would
 * break capability-matrix parity (AGENTS.md invariant 4). Both build from
 * the same list in `@editorzero/capabilities`.
 *
 * The parity coherence test in `generator/parity.unit.test.ts` closes the
 * remaining loop between this registry and the generated command tree:
 *
 *   - Every capability whose `surfaces` array contains `"cli"` must have
 *     `deriveHttpBinding(cap)` point at a real registered route on the
 *     api-server trunk (route-parity guard: catches irregular plurals,
 *     prefix drift, verb drift).
 *   - Every such capability must be reachable as a subcommand under its
 *     `<domain>` top-level command (root-wiring guard).
 *   - No orphan subcommands: every generated subcommand has a capability
 *     backing it.
 *
 * Adding a new capability is a one-line edit in `createDefaultRegistry()`;
 * the generated command tree and the parity test pick it up here
 * automatically.
 */

import { createDefaultRegistry } from "@editorzero/capabilities";

export const cliRegistry = createDefaultRegistry();
