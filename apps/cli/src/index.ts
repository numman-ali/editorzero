#!/usr/bin/env node
/**
 * `editorzero` CLI binary entry (ADR 0021, ADR 0025).
 *
 * Excluded from coverage (see `vitest.config.ts`) — this file is
 * `runMain` wiring and nothing else. The command tree it composes is
 * tested via each subcommand's unit tests + `auth.integration.test.ts`
 * end-to-end smoke.
 *
 * The binary ships as a `bun build --compile` single-file executable
 * (see ADR 0012); the `#!/usr/bin/env node` shebang lets the package's
 * `bin` field work under `pnpm dlx` and `npx` before the compiled
 * distribution lands.
 */

import { defineCommand, runMain } from "citty";

import { authCommand } from "./auth";

const main = defineCommand({
  meta: {
    name: "editorzero",
    description: "editorzero — open-source AI-native docs + collaboration CLI",
  },
  subCommands: {
    auth: authCommand,
  },
});

runMain(main);
