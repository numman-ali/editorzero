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
    // biome-ignore lint/complexity/useLiteralKeys: TS4111 (noPropertyAccessFromIndexSignature) — `obj` is Record<string, unknown>.
    const cookie = obj["cookie"];
    if (typeof cookie !== "string" || cookie.length === 0) return null;
    return { cookie };
  }

  async write(headers: CredentialHeaders): Promise<void> {
    // biome-ignore lint/complexity/useLiteralKeys: TS4111 (noPropertyAccessFromIndexSignature) — CredentialHeaders is a Readonly<Record<string, string>> index signature, so bracket access is required.
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
