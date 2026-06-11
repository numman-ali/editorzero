/**
 * Sign-in / sign-up flow logic (ADR 0030) — the testable core the login
 * screen wraps. The network calls live in `@editorzero/api-client`'s auth
 * seam; this module owns the SPA-side policy: mode dispatch, transport-
 * failure mapping, and the post-login redirect-target guard.
 */
import { signInEmail, signUpEmail } from "@editorzero/api-client";

export type AuthMode = "sign-in" | "sign-up";

export interface CredentialFields {
  readonly email: string;
  readonly password: string;
  /** Display name — required by Better Auth's sign-up body; ignored on sign-in. */
  readonly name: string;
}

/** Injectable network seams so unit tests exercise the policy without HTTP. */
export interface AuthenticateDeps {
  readonly signIn?: typeof signInEmail;
  readonly signUp?: typeof signUpEmail;
}

/**
 * Run the credential flow for `mode`. Returns `null` on success or a
 * user-displayable failure message — the form's single error channel.
 * HTTP failures carry Better Auth's own message; a transport rejection
 * (server unreachable) maps to a friendly line instead of throwing into
 * the render path.
 */
export async function authenticate(
  mode: AuthMode,
  fields: CredentialFields,
  deps: AuthenticateDeps = {},
): Promise<string | null> {
  const signIn = deps.signIn ?? signInEmail;
  const signUp = deps.signUp ?? signUpEmail;
  try {
    const result =
      mode === "sign-up"
        ? await signUp({ email: fields.email, password: fields.password, name: fields.name })
        : await signIn({ email: fields.email, password: fields.password });
    return result.ok ? null : result.message;
  } catch {
    return "Could not reach the server. Check your connection and try again.";
  }
}

/**
 * Clamp the `?redirect=` search param to an internal path. The guard's
 * `location.href` is origin-stripped, so well-formed values always start
 * with a single `/` — but the param is still attacker-writable in a crafted
 * link, so absolute URLs (`https://…`) and protocol-relative (`//…`) forms
 * fall back to the app home rather than becoming an open redirect.
 */
export function safeRedirectTarget(redirect: string | undefined): string {
  if (redirect === undefined || !redirect.startsWith("/") || redirect.startsWith("//")) {
    return "/";
  }
  return redirect;
}
