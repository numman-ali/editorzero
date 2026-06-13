/**
 * `ez auth` — command aggregator (citty wiring).
 *
 * This file is excluded from coverage (see `vitest.config.ts`) — it's
 * the binding layer between citty's `defineCommand` surface and the
 * pure `runX` functions each sibling file exports. Every branch of
 * user-visible behaviour is exercised in `login.unit.test.ts` /
 * `logout.unit.test.ts` / `whoami.unit.test.ts` against dep-injected
 * fakes, and in `auth.integration.test.ts` against a real in-memory
 * trunk. The citty wrapper here only decides which real dep to inject
 * (SessionCookieStore, global fetch, process.stdout) and how to
 * resolve the password input (stdin vs interactive).
 *
 * Password resolution: ADR 0025 §commitment 3. `--password-stdin`
 * always wins; otherwise TTY → interactive prompt, non-TTY → hard
 * fail with `auth_no_password`.
 */

import { defineCommand } from "citty";

import { createCredentialStore, SessionCookieStore } from "../credential-store";
import { emitError } from "../io";
import { promptPasswordInteractive, readPasswordFromStdin } from "../prompt-password";
import { runLogin } from "./login";
import { runLogout } from "./logout";
import { runWhoami } from "./whoami";

async function resolvePassword(passwordStdin: boolean): Promise<string | null> {
  if (passwordStdin) return readPasswordFromStdin();
  if (process.stdin.isTTY !== true) {
    emitError(
      "auth_no_password",
      "Non-TTY invocation requires --password-stdin. Pipe the password to stdin and pass the flag.",
      {},
      process.stdout,
    );
    process.exitCode = 1;
    return null;
  }
  return promptPasswordInteractive();
}

const loginCommand = defineCommand({
  meta: { name: "login", description: "Sign in to an editorzero server." },
  args: {
    email: { type: "string", required: true, description: "Email address to sign in as." },
    "password-stdin": {
      type: "boolean",
      description: "Read password from stdin (required in non-TTY mode).",
    },
    "base-url": {
      type: "string",
      default: "http://localhost:3000",
      description: "Base URL of the editorzero API server.",
    },
  },
  async run({ args }) {
    const password = await resolvePassword(args["password-stdin"] === true);
    if (password === null) return;
    const exitCode = await runLogin(
      { baseUrl: args["base-url"], email: args.email, password },
      { store: new SessionCookieStore(), fetch, stdout: process.stdout },
    );
    process.exitCode = exitCode;
  },
});

const logoutCommand = defineCommand({
  meta: {
    name: "logout",
    description: "Clear the local credential and invalidate the session server-side.",
  },
  args: {
    "base-url": { type: "string", default: "http://localhost:3000" },
  },
  async run({ args }) {
    const exitCode = await runLogout(
      { baseUrl: args["base-url"] },
      { store: new SessionCookieStore(), fetch, stdout: process.stdout },
    );
    process.exitCode = exitCode;
  },
});

const whoamiCommand = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the resolved editorzero Principal for the current credential.",
  },
  args: {
    "base-url": { type: "string", default: "http://localhost:3000" },
  },
  async run({ args }) {
    // `whoami` is the principal-orientation command — it must reflect the
    // SAME credential the capability commands use. When EDITORZERO_AGENT_TOKEN
    // is set, that's the agent token, so an agent can verify "who am I"
    // resolves to its own `AgentPrincipal` (ADR 0044). `login`/`logout` stay
    // cookie-only above: an agent presents a token, it never logs in or out.
    // (Bracket access: `process.env` is an index signature — TS4111.)
    const agentToken = process.env["EDITORZERO_AGENT_TOKEN"]?.trim();
    const exitCode = await runWhoami(
      { baseUrl: args["base-url"] },
      { store: createCredentialStore(agentToken), fetch, stdout: process.stdout },
    );
    process.exitCode = exitCode;
  },
});

export const authCommand = defineCommand({
  meta: { name: "auth", description: "Authentication commands." },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    whoami: whoamiCommand,
  },
});
