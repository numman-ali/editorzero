#!/usr/bin/env node
/**
 * `editorzero` CLI binary entry (ADR 0021, ADR 0025).
 *
 * Excluded from coverage (see `vitest.config.ts`) — this file is
 * `runMain` + `createDomainCommand` wiring and nothing else. The
 * generator core is tested in `src/generator/*.unit.test.ts`; the
 * `doc.list` round-trip is covered by `src/doc-list.integration.test.ts`.
 *
 * The binary ships as a `bun build --compile` single-file executable
 * (see ADR 0012); the `#!/usr/bin/env node` shebang lets the package's
 * `bin` field work under `pnpm dlx` and `npx` before the compiled
 * distribution lands.
 *
 * **Domain-command generation.** Every capability in the CLI registry
 * with `surfaces: ["cli"]` becomes a subcommand under its `<domain>.`
 * top-level citty command — no hand-wired switch. Today's N=1 (doc.list)
 * lights up as `ez doc list`; adding capabilities to `./registry.ts`
 * is sufficient to grow the command tree. The parity contract test
 * (commit 3) fails the build if a capability in the registry omits its
 * CLI surface after this wiring lands.
 */

import { defineCommand, runMain } from "citty";

import { authCommand } from "./auth";
import { createCredentialStore } from "./credential-store";
import { createRootCommands } from "./generator/root";
import { cliRegistry } from "./registry";

// `EDITORZERO_AGENT_TOKEN`, when set, makes the CLI authenticate as an
// owned agent (ADR 0044 Decision 4): every capability command presents the
// token as an `Authorization: Bearer` credential instead of the cookie
// written by `ez auth login`. Read ONCE here at the entry — the
// `no-process-env` confinement boundary — and trimmed (env vars sourced
// from `$(cat token)` or here-strings commonly carry a trailing newline).
// The pure `createCredentialStore` does the cookie-vs-bearer selection.
// (Bracket access: `process.env` is an index signature — dot access is a
// TS4111 error under `noPropertyAccessFromIndexSignature`.)
const agentToken = process.env["EDITORZERO_AGENT_TOKEN"]?.trim();

const registryCommands = createRootCommands(cliRegistry, {
  storeFactory: () => createCredentialStore(agentToken),
  fetch,
  stdout: process.stdout,
});

const main = defineCommand({
  meta: {
    name: "editorzero",
    description: "editorzero — open-source AI-native docs + collaboration CLI",
  },
  subCommands: {
    // `auth` is hand-written (not registry-derived) per ADR 0025 — the
    // bootstrap seam predates the capability-registry surface. Every
    // other top-level domain flows through `createRootCommands` so a
    // capability with `surfaces: ["cli"]` in any domain is reachable
    // from this binary without a second hand-mount. The parity test
    // in `generator/parity.unit.test.ts` enforces that loop.
    auth: authCommand,
    ...registryCommands,
  },
});

runMain(main);
