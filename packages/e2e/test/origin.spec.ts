import { expect, test } from "@playwright/test";

import { TRUNK_ORIGIN, WEB_ORIGIN } from "./servers";

/**
 * The rejection arms the happy-path suite can't see (Codex 2026-06-11
 * MEDIUM): direct HTTP against the trunk origin — no browser page, no
 * Vite proxy — proving the hostile branches actually fire.
 *
 *  - Better Auth's origin middleware rejects a *cookie-bearing*
 *    credential POST whose Origin is not in `trustedOrigins` (ADR 0030
 *    — the CSRF posture the same-origin proxy deliberately satisfies in
 *    the happy path). Cookie-bearing is the load-bearing qualifier: BA
 *    skips origin validation for cookieless requests (origin-check.mjs
 *    `useCookies` guard) because a request carrying no cookie has no
 *    session to ride — that's CLI-class traffic, judged on credentials
 *    (our own `ez login` depends on it). Cookieless *browser* form
 *    forgeries are separately rejected by BA's Fetch-Metadata CSRF
 *    middleware, which non-browser clients don't trip.
 *  - The `first-user` registration gate (the e2e trunk runs the
 *    production default) closes `/auth/sign-up/email` after the genesis
 *    account from auth.spec.ts exists — hiding the form is UX, this is
 *    the enforcement.
 *
 * Both specs use their own throwaway identities — deliberately not the
 * happy-path account (the cross-origin rejection fires before
 * credentials are ever checked).
 */
test("a cookie-bearing cross-origin credential POST is rejected and sets no cookie", async ({
  playwright,
}) => {
  const ctx = await playwright.request.newContext({
    baseURL: TRUNK_ORIGIN,
    extraHTTPHeaders: {
      origin: "http://evil.invalid",
      // The CSRF shape: a session-riding browser request. Without a
      // cookie BA deliberately skips the origin check (see header note).
      cookie: "better-auth.session_token=riding-the-victims-session",
    },
  });
  const res = await ctx.post("/auth/sign-in/email", {
    data: { email: "nobody@e2e.editorzero.test", password: "irrelevant-password" },
  });
  expect(res.status()).toBe(403);
  expect(res.headers()["set-cookie"]).toBeUndefined();
  await ctx.dispose();
});

test("sign-up after genesis is rejected by the first-user registration gate", async ({
  playwright,
}) => {
  // Trusted Origin header on purpose: the rejection being asserted is
  // the registration gate, not the origin check.
  const ctx = await playwright.request.newContext({
    baseURL: TRUNK_ORIGIN,
    extraHTTPHeaders: { origin: WEB_ORIGIN },
  });
  const attempt = {
    email: "stranger@e2e.editorzero.test",
    password: "stranger-pass-123",
    name: "Stranger",
  };
  const res = await ctx.post("/auth/sign-up/email", { data: attempt });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({
    message: expect.stringContaining("Registration is closed"),
  });
  expect(res.headers()["set-cookie"]).toBeUndefined();

  // The attempted credentials never became an account.
  const signIn = await ctx.post("/auth/sign-in/email", {
    data: { email: attempt.email, password: attempt.password },
  });
  expect(signIn.status()).toBe(401);
  await ctx.dispose();
});
