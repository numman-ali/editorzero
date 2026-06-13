/**
 * `AuthCredentialStore` — the CLI's credential-IO seam (ADR 0025).
 *
 * The store is the one lever the CLI pulls to swap between bootstrap
 * credential models. `SessionCookieStore` is the slice-1 impl;
 * follow-ons (device flow, PAT, agent-auth delegated tokens) each plug
 * in a new implementation without touching command handlers or the
 * `createHttpClient` wiring.
 *
 * Stored format is `{ cookie: string }` — just the set-cookie-style
 * header value the CLI will send back on subsequent requests. No
 * refresh token, no expiry — BA sessions expire server-side and
 * surface as 401s; the CLI's response is "fail loud with
 * `code: auth_expired` and direct the user to re-login" (ADR 0025
 * §load-bearing commitment 5).
 *
 * File permissions are 0600 on the credential file and 0700 on the
 * parent directory — same posture as SSH config. The write path
 * chmods explicitly after write so a pre-existing file with looser
 * permissions is tightened, not preserved.
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CredentialHeaders = Readonly<Record<string, string>>;

export interface AuthCredentialStore {
  read(): Promise<CredentialHeaders | null>;
  write(headers: CredentialHeaders): Promise<void>;
  clear(): Promise<void>;
}

export interface SessionCookieStoreOptions {
  /** Defaults to `~/.editorzero/credentials`. */
  readonly path?: string;
}

export class SessionCookieStore implements AuthCredentialStore {
  readonly #path: string;

  constructor(options: SessionCookieStoreOptions = {}) {
    this.#path = options.path ?? join(homedir(), ".editorzero", "credentials");
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<CredentialHeaders | null> {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (err) {
      // File missing → no credential. Any other IO error treated the
      // same way: downstream produces `auth_expired` and directs the
      // caller to re-login, which re-writes the file with correct
      // permissions. Recovering silently avoids half-states where a
      // permission-toggled file looks like a logged-in credential.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted file — same "no credential" posture.
      return null;
    }
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    // Bracket access: `obj` is an index signature (Record<string, unknown>)
    // — dot access is a TS4111 error under noPropertyAccessFromIndexSignature.
    const cookie = obj["cookie"];
    if (typeof cookie !== "string" || cookie.length === 0) return null;
    return { cookie };
  }

  async write(headers: CredentialHeaders): Promise<void> {
    // Bracket access: `CredentialHeaders` is a Readonly<Record<string, string>>
    // index signature — dot access is a TS4111 error.
    const cookie = headers["cookie"] ?? headers["Cookie"];
    if (typeof cookie !== "string" || cookie.length === 0) {
      throw new Error("SessionCookieStore.write: no `cookie` in headers");
    }
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    writeFileSync(this.#path, JSON.stringify({ cookie }, null, 2), { mode: 0o600 });
    // Belt-and-braces chmod — `mode` on `writeFileSync` is honored only
    // when creating the file; an existing file retains its permissions.
    chmodSync(this.#path, 0o600);
  }

  async clear(): Promise<void> {
    try {
      unlinkSync(this.#path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * `BearerTokenStore` — the owned-agent-token credential model (ADR 0044
 * Decision 4, CLI side). Where `SessionCookieStore` round-trips a Better
 * Auth session cookie through a 0600 file, this store carries an owned
 * agent token (`ez_agent_…`) sourced from the environment
 * (`EDITORZERO_AGENT_TOKEN`, read at the binary entry — the
 * `no-process-env` confinement boundary) and presents it as an RFC 6750
 * `Authorization: Bearer` header. The server's bearer arm
 * (`createBearerThenCookieResolver`) resolves that header to an
 * `AgentPrincipal`; the existing transport (`invoke.ts` spreads the
 * credential map onto the request headers) carries it with no change.
 *
 * The credential is env-sourced and immutable from the CLI's side:
 *   - `read()` returns the bearer header, always. The token IS the
 *     credential — there is no "logged out" state to represent, so this
 *     never returns `null` (a missing token means a `SessionCookieStore`
 *     was selected instead — see `createCredentialStore`).
 *   - `write()` THROWS. `ez auth login` writes a *cookie*; there is no
 *     cookie here, and persisting a token to disk is deliberately not a
 *     CLI action — the token lives in the environment / a secret manager.
 *   - `clear()` is a NO-OP. There is no local file to remove. A 401 on an
 *     agent token means it was revoked or expired server-side; the remedy
 *     is to rotate / re-mint the token (an owner action), not to wipe
 *     local state. (`SessionCookieStore.clear()` deletes the cookie file
 *     on a 401; the bearer store has nothing to delete.)
 */
export class BearerTokenStore implements AuthCredentialStore {
  readonly #header: CredentialHeaders;

  constructor(token: string) {
    this.#header = { authorization: `Bearer ${token}` };
  }

  async read(): Promise<CredentialHeaders> {
    return this.#header;
  }

  async write(_headers: CredentialHeaders): Promise<never> {
    throw new Error(
      "BearerTokenStore is read-only: the agent credential comes from the " +
        "EDITORZERO_AGENT_TOKEN environment variable. To use cookie-based " +
        "login (`ez auth login`), unset EDITORZERO_AGENT_TOKEN.",
    );
  }

  async clear(): Promise<void> {
    // No-op: the credential is env-sourced, not a local file. A 401 here
    // means the token was revoked or expired server-side — rotate / re-mint
    // the token (an owner action); there is nothing local to clear.
  }
}

/**
 * Selects the credential model from an optional agent token. A non-empty
 * `EDITORZERO_AGENT_TOKEN` (read + trimmed at the binary entry) makes the
 * CLI authenticate as that agent via a `BearerTokenStore`; otherwise it
 * falls back to the cookie model (`SessionCookieStore`, fed by
 * `ez auth login`).
 *
 * Pure — it does not read the environment itself — so the selection is
 * unit-testable and the single `process.env` read stays confined to the
 * entry point (the `no-process-env` rule). An env value of `undefined` or
 * `""` (e.g. `EDITORZERO_AGENT_TOKEN=` or whitespace-only after trim)
 * selects the cookie store rather than constructing a doomed bearer
 * credential.
 */
export function createCredentialStore(agentToken: string | undefined): AuthCredentialStore {
  if (agentToken !== undefined && agentToken.length > 0) {
    return new BearerTokenStore(agentToken);
  }
  return new SessionCookieStore();
}
