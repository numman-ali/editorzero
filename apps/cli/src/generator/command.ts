/**
 * Capability → citty command (ADR 0021 §CLI generator).
 *
 * `createCapabilityCommand(capability, runOpts)` produces a citty
 * `CommandDef` whose `meta.name` is the action half of the capability
 * id (e.g., `"list"` for `doc.list`), whose `meta.description` is
 * the capability's `summary`, whose `args` are derived from the input
 * zod schema via `deriveFlags`, and whose `run` hands off to
 * `runCapability` with a real dep graph (`SessionCookieStore`, global
 * `fetch`, `process.stdout`).
 *
 * `createDomainCommand("doc", capabilities)` groups every capability
 * whose id starts with `"doc."` into one citty command with each
 * action as a subcommand. The intent is that every domain in the
 * registry with at least one `surfaces: ["cli"]` capability gets
 * exactly one top-level `ez <domain>` command and the action tree
 * under it is derived end-to-end — no hand-maintained switch.
 *
 * The `--base-url` flag is added at the capability-command level so
 * every `ez doc <action>` invocation honours it. The default matches
 * the dev-server port convention (`http://localhost:3000`). A server
 * that reshapes its base URL at deploy time sets the value explicitly
 * (a follow-up slice will honour `$EDITORZERO_BASE_URL` too).
 */

import type { AnyCapability } from "@editorzero/capabilities";
import { type ArgsDef, type CommandDef, defineCommand } from "citty";

import type { AuthCredentialStore } from "../credential-store";
import { deriveFlags } from "./flags";
import { runCapability } from "./invoke";

export interface CapabilityCommandOpts {
  /**
   * Credential-store factory. A factory (not a shared instance) so
   * commands pick up file changes between invocations — matters for
   * the test harness that seeds a store per-test, and for the
   * production CLI when a subsequent invocation happens after a fresh
   * login.
   */
  readonly storeFactory: () => AuthCredentialStore;
  readonly fetch: typeof fetch;
  readonly stdout: NodeJS.WritableStream;
  /** Defaults to `http://localhost:3000`. */
  readonly defaultBaseUrl?: string;
}

export function createCapabilityCommand(
  capability: AnyCapability,
  opts: CapabilityCommandOpts,
): CommandDef {
  const [, action] = capability.id.split(".");
  if (action === undefined) {
    throw new Error(
      `createCapabilityCommand: capability id "${capability.id}" does not match <domain>.<action>.`,
    );
  }
  const defaultBaseUrl = opts.defaultBaseUrl ?? "http://localhost:3000";
  const flags = deriveFlags(capability.input);
  const args: ArgsDef = {
    ...flags,
    "base-url": {
      type: "string",
      default: defaultBaseUrl,
      description: "Base URL of the editorzero API server.",
    },
  };
  return defineCommand({
    meta: {
      name: action,
      description: capability.summary,
    },
    args,
    async run({ args }) {
      const baseUrl = typeof args["base-url"] === "string" ? args["base-url"] : defaultBaseUrl;
      const rawArgs: Record<string, unknown> = {};
      for (const key of Object.keys(flags)) {
        rawArgs[key] = args[key];
      }
      const exitCode = await runCapability(
        capability,
        { baseUrl, rawArgs },
        { store: opts.storeFactory(), fetch: opts.fetch, stdout: opts.stdout },
      );
      process.exitCode = exitCode;
    },
  });
}

export function createDomainCommand(
  domain: string,
  capabilities: readonly AnyCapability[],
  opts: CapabilityCommandOpts,
): CommandDef {
  const prefix = `${domain}.`;
  const scoped = capabilities.filter((c) => c.id.startsWith(prefix) && c.surfaces.includes("cli"));
  const subCommands: Record<string, CommandDef> = {};
  for (const cap of scoped) {
    const [, action] = cap.id.split(".");
    if (action === undefined) continue;
    subCommands[action] = createCapabilityCommand(cap, opts);
  }
  return defineCommand({
    meta: {
      name: domain,
      description: `Commands on the ${domain} domain (registry-derived).`,
    },
    subCommands,
  });
}
