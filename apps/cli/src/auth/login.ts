/**
 * `ez auth login` — run-function (ADR 0025).
 *
 * Posts email + password to `/auth/sign-in/email` on the trunk,
 * extracts the resulting `Set-Cookie` session-token value, and
 * persists it via the injected `AuthCredentialStore`. The command
 * wrapper in `./index.ts` instantiates a real `SessionCookieStore` +
 * global `fetch` and calls `runLogin` with a resolved password (from
 * `--password-stdin` or the interactive TTY prompt).
 *
 * Why it posts to `/auth/sign-in/email` directly (not via `hc<AppType>`):
 * Better Auth's routes are mounted on the trunk via `.on("/auth/*",
 * handler)` — outside the typed `.route()` capability mounts.
 * `hc<AppType>` can't reach them. A raw fetch against a known BA
 * endpoint is the
 * contract we consume. This ADR's transitional bootstrap explicitly
 * depends on those routes being live (`/auth/sign-in/email`,
 * `/auth/sign-out`), both of which ship today.
 *
 * Set-Cookie parsing: BA may return multiple cookies (session_token,
 * csrf, ...) in a single `Set-Cookie` header separated by commas.
 * `Headers.get("set-cookie")` concatenates them. The split regex
 * matches `,(?=\s*[^ ;]+=)` — commas that precede a new cookie
 * definition — then takes the `name=value` prefix from each. Same
 * parser used by `packages/api-server/src/composition/
 * auth-chain.integration.test.ts` and `packages/auth/src/
 * create-auth.integration.test.ts`; keeping them aligned avoids
 * three drifting forks of the same split.
 */

import type { AuthCredentialStore } from "../credential-store";
import { emit, emitError } from "../io";

export interface RunLoginArgs {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
}

export interface RunLoginDeps {
  readonly store: AuthCredentialStore;
  readonly fetch: typeof fetch;
  readonly stdout: NodeJS.WritableStream;
}

export async function runLogin(args: RunLoginArgs, deps: RunLoginDeps): Promise<number> {
  const { baseUrl, email, password } = args;
  const { store, fetch: fetchImpl, stdout } = deps;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    emitError(
      "network_error",
      "Could not reach the editorzero API. Check `--base-url` and that the server is running.",
      { message: (err as Error).message ?? "unknown" },
      stdout,
    );
    return 1;
  }

  if (res.status !== 200) {
    emitError(
      "auth_failed",
      "Sign-in failed. Check email/password or the `--base-url` value.",
      { status: res.status },
      stdout,
    );
    return 1;
  }

  const cookie = extractSessionCookie(res);
  if (cookie === "") {
    emitError(
      "auth_missing_cookie",
      "Sign-in returned 200 without a Set-Cookie header — the server's Better Auth stack is misconfigured.",
      {},
      stdout,
    );
    return 1;
  }

  await store.write({ cookie });
  emit({ ok: true, email }, stdout);
  return 0;
}

function extractSessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie
    .split(/,(?=\s*[^ ;]+=)/u)
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter((c) => c.length > 0)
    .join("; ");
}
