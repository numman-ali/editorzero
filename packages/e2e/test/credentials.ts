/**
 * The genesis account. `auth.spec.ts` (alphabetically first, serial) signs
 * it up — which per ADR 0041 bootstraps the workspace + owner membership —
 * and every later spec that needs an authenticated principal signs in with
 * it (the registration gate closes self-serve sign-up after genesis, so
 * specs cannot mint their own accounts).
 */
export const CREDENTIALS = {
  email: "founder@e2e.editorzero.test",
  password: "e2e-password-123",
  name: "Founding User",
} as const;
