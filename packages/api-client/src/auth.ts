/**
 * Email-credential auth calls (Better Auth, ADR 0030) — the sanctioned
 * raw-fetch module for the trunk's `/auth/*` routes.
 *
 * Better Auth's routes are mounted via `.on(["POST","GET"], "/auth/*", …)`,
 * outside the typed `.route()` capability chain, so `hc<AppType>` cannot
 * reach them (the same constraint `apps/cli/src/auth/login.ts` documents).
 * This module is the shared client-side counterpart: one place that knows
 * the endpoint paths + body shapes, so raw auth fetches never scatter
 * across consumers (ADR 0028's single-seam rule, extended to the auth
 * boundary).
 *
 * Cookie handling is deliberately absent: in the browser the session
 * cookie is applied by the user agent (`credentials: "include"`, mirroring
 * `createHttpClient`); the CLI keeps its own `Set-Cookie` extraction for
 * its credential store. HTTP failures are projected into an `AuthResult`
 * (Better Auth's `{ message }` body when present, a status fallback when
 * not); transport failures (network down) propagate as rejections for the
 * caller to map.
 */

export interface AuthCallOptions {
  /** `""` (default) for the SPA's same-origin calls; an absolute origin elsewhere. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

export interface SignInEmailInput {
  readonly email: string;
  readonly password: string;
}

export interface SignUpEmailInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

/** Outcome of an email-credential call: success, or the HTTP failure projected to a display message. */
export type AuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** `POST /auth/sign-in/email` — establish a session for an existing user. */
export async function signInEmail(
  input: SignInEmailInput,
  options: AuthCallOptions = {},
): Promise<AuthResult> {
  return postAuth("/auth/sign-in/email", input, options);
}

/**
 * `POST /auth/sign-up/email` — create a user. The server's Better Auth
 * user-create hook bootstraps the workspace + owner membership with audited
 * genesis (ADR 0041), so on a fresh install sign-up IS the instance
 * bootstrap — no separate seed step.
 */
export async function signUpEmail(
  input: SignUpEmailInput,
  options: AuthCallOptions = {},
): Promise<AuthResult> {
  return postAuth("/auth/sign-up/email", input, options);
}

async function postAuth(
  path: string,
  body: unknown,
  options: AuthCallOptions,
): Promise<AuthResult> {
  const fetchImpl = options.fetch ?? fetch;
  // `credentials: "include"` so the Set-Cookie on the response is applied by
  // the browser on same-origin/dev-proxy calls — same rationale as
  // `createHttpClient`'s wrapped fetch. Harmless under Node (no cookie jar).
  const res = await fetchImpl(`${options.baseUrl ?? ""}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (res.ok) {
    return { ok: true };
  }
  return { ok: false, status: res.status, message: await readAuthMessage(res) };
}

/**
 * Best-effort display message for a failed auth call. Better Auth answers
 * with `{ message: string }` (e.g. "Invalid email or password"); a non-JSON
 * or message-less body falls back to a status line. Cast-free: the `in`
 * operator narrows the unknown body to a named-property access.
 */
async function readAuthMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string" &&
      body.message.length > 0
    ) {
      return body.message;
    }
  } catch {
    // Non-JSON failure body (e.g. an HTML 5xx). Fall through.
  }
  return `Request failed (HTTP ${res.status}).`;
}
