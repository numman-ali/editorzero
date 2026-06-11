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
 * Clamp the `?redirect=` search param to an internal target. The guard's
 * `location.href` is origin-stripped, but the param is attacker-writable
 * in a crafted link, so this is a security boundary, not a convenience:
 * prefix checks alone miss backslash and encoded-slash forms that URL
 * normalization later re-interprets as an authority (`/\evil.com` parses
 * to `http://evil.com/`; `%5C`/`%2F` in the *path* can decode into the
 * same shapes downstream). So: canonicalize against the app origin and
 * compare — reject raw/encoded backslashes outright, parse, require the
 * resolved origin to match, reject encoded slashes surviving in the
 * pathname (search/hash keep theirs — `?q=a%2Fb` is legitimate), and
 * return only the re-assembled `pathname + search + hash`, never the
 * original string. (Codex 2026-06-11 HIGH; through today's only call
 * path TanStack's `navigate({href})` → pushState would throw on a
 * cross-origin resolution anyway — the clamp must not depend on that
 * accident of safety.)
 */
export function safeRedirectTarget(
  redirect: string | undefined,
  baseOrigin: string = liveOrigin(),
): string {
  if (redirect === undefined || redirect.includes("\\") || /%5c/i.test(redirect)) {
    return "/";
  }
  let target: URL;
  let base: URL;
  try {
    base = new URL(baseOrigin);
    target = new URL(redirect, base);
  } catch {
    return "/";
  }
  if (target.origin !== base.origin || /%2f/i.test(target.pathname)) {
    return "/";
  }
  return `${target.pathname}${target.search}${target.hash}`;
}

/**
 * The browser origin, with a parseable placeholder under the node test
 * runner (this module's vitest lane runs without a DOM — same posture
 * as `theme.ts`'s injected seams). Real callers run in the browser.
 */
function liveOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}
