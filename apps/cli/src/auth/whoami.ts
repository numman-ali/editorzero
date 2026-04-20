/**
 * `ez auth whoami` — run-function (ADR 0025).
 *
 * Calls `/infra/whoami` on the trunk — the canonical principal-
 * orientation route — via the typed `hc<AppType>` client from
 * `@editorzero/api-client`. Same middleware chain as every capability
 * route → same `Principal` truth the dispatcher/gate enforces.
 *
 * Not `/auth/get-session` (that returns BA's session/user shape and
 * diverges from what editorzero actually enforces; see ADR 0025 §2
 * "load-bearing commitments").
 *
 * Error handling:
 *   - No local credential → `auth_expired` error envelope, exit 1.
 *     Same posture as a 401 from the server: fail loud and direct
 *     the user to `ez auth login`.
 *   - 401 from the server (session expired) → clear the local
 *     credential (it's no longer valid) and emit `auth_expired`.
 *     Clearing locally avoids a confusing state where subsequent
 *     calls would repeat the same 401.
 *   - Any other non-200 → emit `request_failed` with the status code.
 *     Rare; surfaces real-world issues (DNS, TLS, 502, …) clearly.
 */

import { createHttpClient } from "@editorzero/api-client";
import type { AuthCredentialStore } from "../credential-store";
import { emit, emitError } from "../io";

export interface RunWhoamiArgs {
  readonly baseUrl: string;
}

export interface RunWhoamiDeps {
  readonly store: AuthCredentialStore;
  readonly fetch: typeof fetch;
  readonly stdout: NodeJS.WritableStream;
}

export async function runWhoami(args: RunWhoamiArgs, deps: RunWhoamiDeps): Promise<number> {
  const { baseUrl } = args;
  const { store, fetch: fetchImpl, stdout } = deps;

  const credential = await store.read();
  if (credential === null) {
    emitError(
      "auth_expired",
      "No local credential. Run `ez auth login` to authenticate.",
      {},
      stdout,
    );
    return 1;
  }

  const client = createHttpClient({
    baseUrl,
    auth: () => credential,
    fetch: fetchImpl,
  });

  try {
    const res = await client.infra.whoami.$get();
    // Widen `status` to `number` so the `!== 200` fallback branch
    // isn't narrowed away by the typed-client's discriminated-union
    // response. Hono's typed client constrains *expected* statuses
    // (200/401 per the route's OpenAPI `responses`); a real server
    // can still emit 500/502/etc. which the narrowing would declare
    // unreachable even though it's a real runtime possibility.
    const status: number = res.status;
    if (status === 401) {
      await store.clear();
      emitError(
        "auth_expired",
        "Session expired. Run `ez auth login` to re-authenticate.",
        {},
        stdout,
      );
      return 1;
    }
    if (status !== 200) {
      emitError(
        "request_failed",
        `Unexpected server response (status ${status}).`,
        { status },
        stdout,
      );
      return 1;
    }
    const body = await res.json();
    emit(body, stdout);
    return 0;
  } catch (err) {
    emitError(
      "network_error",
      "Could not reach the editorzero API. Check `--base-url` and that the server is running.",
      { message: (err as Error).message ?? "unknown" },
      stdout,
    );
    return 1;
  }
}
