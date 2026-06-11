import type { FormEvent } from "react";
import { useState } from "react";

import type { AuthMode, CredentialFields } from "../lib/auth";
import { authenticate } from "../lib/auth";

import "./auth-form.css";

/**
 * Sign-in / sign-up card (ADR 0030; visual spec docs/brand/v2/screens/
 * 12-login.html, State 2). One component carries both modes — the toggle
 * lives in the foot-line, entered email/password persist across the switch,
 * and the name field appears only for sign-up (Better Auth's sign-up body
 * requires it). Sign-up doubles as the fresh-install bootstrap: the server
 * auto-provisions the workspace + owner membership with an audited genesis
 * (ADR 0041), so there is no separate first-run wizard to gate on.
 *
 * The mock's SSO buttons and "Forgot?" link are deliberately absent — those
 * server features don't exist yet, and dead controls fail the e2e's axe +
 * honesty bar. The agent footnote stays: agents authenticate with bearer
 * tokens, never through this form (ADR 0016).
 *
 * Coverage: presentational wiring excluded from vitest unit coverage like
 * `app-shell.tsx`; the policy (mode dispatch, failure mapping, redirect
 * clamping) lives tested in `lib/auth.ts`, and the full browser round-trip
 * is the Playwright + axe e2e lane's first spec (ADR 0033).
 */
export function AuthForm({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [revealPassword, setRevealPassword] = useState(false);

  const signUp = mode === "sign-up";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const data = new FormData(event.currentTarget);
    const fields: CredentialFields = {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
      name: String(data.get("name") ?? ""),
    };
    setPending(true);
    setFailure(null);
    const message = await authenticate(mode, fields);
    if (message !== null) {
      setFailure(message);
      setPending(false);
      return;
    }
    // Stay pending through the redirect — the route unmounts this form.
    await onAuthenticated();
  }

  function switchMode() {
    setMode(signUp ? "sign-in" : "sign-up");
    setFailure(null);
    setRevealPassword(false);
  }

  return (
    <section className="login-panel" aria-label={signUp ? "Create account" : "Sign in"}>
      <div className="login-ch">
        <span className="id">{signUp ? "Create your account" : "Sign in"}</span>
        <span className="tag">
          <span className="chip chip--ghost">{signUp ? "NEW" : "RETURNING"}</span>
        </span>
      </div>
      <div className="login-card">
        <div className="login-brand">
          <div className="markwrap" aria-hidden="true">
            <span className="cross" />
            <span className="cross-ring" />
          </div>
          <h1 className="title">
            editor<b>zero</b>
          </h1>
          <p className="lede">
            {signUp
              ? "Set up your workspace. Real-time docs, co-edited by humans and agents."
              : "Sign in to your workspace. Real-time docs, co-edited by humans and agents."}
          </p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-fl">
            <label className="login-lbl" htmlFor="auth-email">
              Email <span className="req">*</span>
            </label>
            <input
              id="auth-email"
              className="login-input"
              name="email"
              type="email"
              required
              autoComplete={signUp ? "email" : "username"}
              placeholder="you@example.com"
            />
          </div>
          {signUp ? (
            <div className="login-fl">
              <label className="login-lbl" htmlFor="auth-name">
                Name <span className="req">*</span>
              </label>
              <input
                id="auth-name"
                className="login-input"
                name="name"
                type="text"
                required
                autoComplete="name"
                placeholder="Ada Lovelace"
              />
            </div>
          ) : null}
          <div className="login-fl">
            <label className="login-lbl" htmlFor="auth-password">
              Password <span className="req">*</span>
            </label>
            <div className="login-affix">
              <input
                id="auth-password"
                className="login-input mono"
                name="password"
                type={revealPassword ? "text" : "password"}
                required
                minLength={signUp ? 8 : undefined}
                autoComplete={signUp ? "new-password" : "current-password"}
                placeholder="••••••••••••"
              />
              <button
                type="button"
                className="ax btn-ax"
                aria-label={revealPassword ? "Hide password" : "Reveal password"}
                onClick={() => setRevealPassword((value) => !value)}
              >
                {revealPassword ? "HIDE" : "SHOW"}
              </button>
            </div>
          </div>

          {failure !== null ? (
            <p className="login-error" role="alert">
              {failure}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary login-submit" disabled={pending}>
            {pending ? "Working…" : signUp ? "Create account →" : "Sign in →"}
          </button>
        </form>

        <div className="login-agentnote">
          <span className="av av--agent ic" aria-hidden="true">
            AI
          </span>
          <div className="tx">
            <b>Agents don't sign in here.</b> They authenticate with an API token —{" "}
            <code>Authorization: Bearer ez_…</code> — never with email + password.
          </div>
        </div>

        <div className="login-actions">
          <p className="login-foot-line">
            {signUp ? "Already have an account? " : "No account? "}
            <button type="button" className="login-link" onClick={switchMode}>
              {signUp ? "Sign in" : "Create one"}
            </button>
          </p>
        </div>
      </div>
    </section>
  );
}
