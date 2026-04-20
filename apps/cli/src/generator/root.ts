/**
 * Registry → root command tree (ADR 0021 §CLI generator).
 *
 * `createRootCommands(registry, opts)` returns `Record<domain,
 * CommandDef>` by grouping every capability in the registry on the
 * `<domain>` half of its `<domain>.<action>` id. Each domain that has
 * at least one capability with `surfaces.includes("cli")` becomes one
 * top-level entry in the returned map.
 *
 * **Why registry-derived rather than hand-mounted.** Hand-mounting a
 * top-level command per domain in `index.ts` works for a single
 * domain but silently drifts the moment a second one lands: a
 * `collection.*` capability could enter the CLI registry, pass per-
 * domain generator unit tests, and still be unreachable from the
 * compiled binary because `index.ts` forgot to add the line. Deriving
 * the root from the registry closes that hole — the parity
 * coherence check in `parity.unit.test.ts` pairs with this derivation
 * to assert every CLI-surfaced capability is both exposed under a
 * subcommand AND that its binding matches a real registered route.
 *
 * The caller is still responsible for hand-mounted commands that
 * aren't registry-derived — `auth` is the one today (ADR 0025
 * bootstrap predates the registry surface). Those stay in
 * `index.ts` as explicit entries; everything that's capability-
 * backed flows through here.
 */

import type { Registry } from "@editorzero/capabilities";
import type { CommandDef } from "citty";

import { type CapabilityCommandOpts, createDomainCommand } from "./command";

export function createRootCommands(
  registry: Registry,
  opts: CapabilityCommandOpts,
): Record<string, CommandDef> {
  const domains = new Set<string>();
  for (const cap of registry.list()) {
    if (!cap.surfaces.includes("cli")) continue;
    const [domain] = cap.id.split(".");
    if (domain === undefined) continue;
    domains.add(domain);
  }
  const result: Record<string, CommandDef> = {};
  for (const domain of domains) {
    result[domain] = createDomainCommand(domain, registry.list(), opts);
  }
  return result;
}
