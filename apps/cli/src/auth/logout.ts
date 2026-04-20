/**
 * `ez auth logout` — run-function (ADR 0025).
 *
 * Posts to `/auth/sign-out` on the trunk with the currently-stored
 * cookie (so Better Auth invalidates the session server-side), then
 * clears the local credential file regardless of the server's
 * response. AXI commitment "idempotent mutations exit 0 on no-op":
 *
 *   - Already logged out (no credential file)          → exit 0, emit `{ ok: true, already: true }`.
 *   - Server returns non-2xx                           → still clear locally, exit 0. The local state is
 *                                                         the only state we can guarantee; the remote
 *                                                         session is on a best-effort track.
 *   - Network error reaching the server                → same as above — clear locally, exit 0 with an
 *                                                         advisory field so callers can tell the server
 *                                                         wasn't pinged.
 *
 * The "always clear locally" posture is deliberate: if a user runs
 * `ez auth logout`, their intent is unambiguously "remove my
 * credential from this machine." Refusing to clear when the server
 * is unreachable would trap them.
 */

import type { AuthCredentialStore } from "../credential-store";
import { emit } from "../io";

export interface RunLogoutArgs {
  readonly baseUrl: string;
}

export interface RunLogoutDeps {
  readonly store: AuthCredentialStore;
  readonly fetch: typeof fetch;
  readonly stdout: NodeJS.WritableStream;
}

export async function runLogout(args: RunLogoutArgs, deps: RunLogoutDeps): Promise<number> {
  const { baseUrl } = args;
  const { store, fetch: fetchImpl, stdout } = deps;

  const credential = await store.read();
  if (credential === null) {
    emit({ ok: true, already: true }, stdout);
    return 0;
  }

  let serverCleared = false;
  try {
    const res = await fetchImpl(`${baseUrl}/auth/sign-out`, {
      method: "POST",
      headers: { ...credential },
    });
    serverCleared = res.ok;
  } catch {
    // Network error — swallow into `server_cleared: false`. Local
    // clear still happens below.
    serverCleared = false;
  }

  await store.clear();
  emit({ ok: true, server_cleared: serverCleared }, stdout);
  return 0;
}
