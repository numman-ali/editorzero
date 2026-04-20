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
import { SessionCookieStore } from "./credential-store";
import { createDomainCommand } from "./generator/command";
import { cliRegistry } from "./registry";

const docCommand = createDomainCommand("doc", cliRegistry.list(), {
  storeFactory: () => new SessionCookieStore(),
  fetch,
  stdout: process.stdout,
});

const main = defineCommand({
  meta: {
    name: "editorzero",
    description: "editorzero — open-source AI-native docs + collaboration CLI",
  },
  subCommands: {
    auth: authCommand,
    doc: docCommand,
  },
});

runMain(main);
