/**
 * `createAuth` — Better Auth instance factory for editorzero
 * (ADR 0010 / ADR 0016).
 *
 * **Scope of this slice (2026-04-19).** Core `better-auth` only —
 * email/password session auth for human users. The agent-facing
 * plugins (`@better-auth/api-key`, `@better-auth/agent-auth`,
 * `@better-auth/oauth-provider`, `@better-auth/mcp`) land in
 * follow-up slices; they are additive and do not alter the session
 * flow this factory configures. SSO (`@better-auth/sso`) is its own
 * slice with migration + provider-config concerns.
 *
 * **Shared SQLite driver.** Better Auth uses the same `SqliteDriver`
 * the rest of the app uses — `{ db: driver.system(), type: "sqlite",
 * transaction: true }`. The `{ db, type, transaction }` shape is a
 * Better Auth 1.6.5 source-verified config path (Codex traced the
 * `createKyselyAdapter` helper 2026-04-19) that lets Better Auth
 * reuse our live Kysely instance rather than minting a second
 * connection. Shared-DB posture means:
 *
 *   - One SQLite file / pool; no split-brain pragma state
 *   - Better Auth tables (`user`, `session`, `account`,
 *     `verification`) coexist with our tables (`docs`,
 *     `doc_updates`, `audit_events`, ...) — no cross-FKs today, so
 *     ordering is independent
 *   - `getMigrations(auth.options).runMigrations()` writes Better
 *     Auth's DDL into the same DB our DDL already populated
 *
 * **`workspaceId` on the user row.** `user.additionalFields.
 * workspaceId` carries the MVP "one workspace per user" constraint.
 * `input: false` so clients can't smuggle a workspace during signup;
 * `databaseHooks.user.create.before` mints a fresh `WorkspaceId`
 * server-side before insert. When multi-workspace lands, an
 * editorzero-owned `workspace_members` table + resolver joins
 * replace this shape — the `UserPrincipal` resolver is the only
 * consumer, so the swap is localised.
 *
 * **`basePath: "/auth"`.** Explicit — Better Auth's default is
 * `/api/auth`, which is fine but creates path drift if the trunk
 * mounts at `/auth/*` without setting `basePath`. Keep in sync with
 * the trunk's `app.on(["POST","GET"], "/auth/*", ...)`.
 *
 * **`baseURL` is required, not inferred.** Better Auth's docs
 * explicitly recommend not relying on request inference for
 * `baseURL`; it affects absolute-URL generation in emails, OAuth
 * redirects, and cookie domain defaults. Callers supply the
 * deployment-appropriate value.
 *
 * **Email+password deliberately without email verification.** MVP
 * constraint. When email delivery lands (separate slice), set
 * `emailAndPassword.requireEmailVerification: true` + wire the
 * `sendResetPassword` / `sendVerificationEmail` callbacks.
 */

import { createHash, randomBytes } from "node:crypto";

import type { SqliteDriver } from "@editorzero/db";
import { generateWorkspaceId, UserId, uuidV7, WorkspaceId } from "@editorzero/ids";
import { betterAuth } from "better-auth";

/**
 * Lowercased, non-alphanumeric collapsed to single dash, trimmed,
 * capped at 40 chars. Used as the human-readable prefix of the
 * workspace slug; paired with `slugSuffix` (a deterministic 6-hex
 * suffix) so the final slug is always non-empty and unique even when
 * this prefix normalizes to an empty string.
 */
function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Deterministic 6-hex suffix derived from the workspace id. Paired
 * with `normalizeSlug(local-part)` to produce a slug that is unique
 * per workspace even when two users share an email local-part — the
 * partial unique index on `workspaces(slug) WHERE deleted_at IS NULL`
 * enforces the floor. Deterministic beats random here: reproducible
 * test fixtures and no retry loop on collision.
 */
function slugSuffix(workspaceId: WorkspaceId): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 6);
}

/**
 * Concrete Better Auth instance returned by `createAuth`. Typed via
 * `ReturnType<typeof createAuth>` rather than the exported
 * `Auth<BetterAuthOptions>` shape because our specific options object
 * (required `baseURL: string`, `additionalFields.workspaceId`, etc.)
 * narrows the inferred return type in ways the wider structural
 * `Auth<BetterAuthOptions>` rejects as non-assignable. Consumers who
 * need the widened form re-export from `better-auth` directly.
 */
export type Auth = ReturnType<typeof createAuth>;

export interface CreateAuthOptions {
  readonly driver: SqliteDriver;
  /**
   * Absolute origin of the deploy — e.g. `http://localhost:3000`
   * in dev, `https://app.editorzero.dev` in prod. Used for
   * absolute-URL generation; not inferred from request.
   */
  readonly baseURL: string;
  /**
   * Signing secret for session tokens. Rotatable via the
   * `BETTER_AUTH_SECRETS` versioned-key shape when multi-key
   * rotation is configured; today a single secret is sufficient.
   * MUST be at least 32 bytes of entropy.
   */
  readonly secret: string;
  /**
   * Optional `trustedOrigins`. Required when the client is served
   * from a different origin than the API. Empty array is fine for
   * same-origin deployments.
   */
  readonly trustedOrigins?: ReadonlyArray<string>;
}

export function createAuth(options: CreateAuthOptions) {
  const { driver, baseURL, secret, trustedOrigins } = options;

  // Better Auth's internal `createKyselyAdapter` accepts
  // `Kysely<any>` at runtime — the types carry its own schema. Our
  // `driver.system()` is typed `Kysely<SystemDatabase>` (editorzero
  // schema). The `unknown` hop satisfies the unrelated-generics
  // constraint; at runtime the underlying SQLite connection is the
  // same, and Better Auth writes to its own tables (`user`,
  // `session`, `account`, `verification`) that don't overlap ours.
  const sharedKysely = driver.system() as unknown;

  return betterAuth({
    baseURL,
    basePath: "/auth",
    secret,
    trustedOrigins: trustedOrigins !== undefined ? [...trustedOrigins] : [],
    database: {
      // biome-ignore lint/suspicious/noExplicitAny: Better Auth's internal adapter uses `Kysely<any>` — see comment above `sharedKysely`.
      db: sharedKysely as any,
      type: "sqlite",
      transaction: true,
    },
    advanced: {
      database: {
        // Override Better Auth's default nanoid-based ID generator
        // with UUIDv7 so the resolver's brand-cast (`UserId(...)`,
        // `SessionId(...)` via `parseV7`) accepts the IDs without
        // widening the brand's UUID invariant. Every editorzero ID
        // column uses UUIDv7 — Better Auth's `user.id` / `session.id`
        // / `account.id` / `verification.id` now follow the same
        // posture. No schema change required; `id TEXT PRIMARY KEY`
        // on Better Auth's side accepts the longer (36-char) string.
        generateId: () => uuidV7(),
      },
    },
    emailAndPassword: {
      enabled: true,
      // Email verification is deferred to the email-delivery slice.
      // Without it, users can sign up and immediately sign in;
      // verification becomes required once
      // `sendVerificationEmail` is wired.
      requireEmailVerification: false,
    },
    user: {
      additionalFields: {
        workspaceId: {
          type: "string",
          // `required: false` on the Better Auth schema surface
          // (not "not required to exist"; required: true would
          // narrow the inferred User type in a way that breaks the
          // structural `Auth<BetterAuthOptions>` return contract).
          // At runtime the `databaseHooks.user.create.before` hook
          // below ALWAYS sets workspaceId, so every user row
          // carries one; the resolver's defensive "missing
          // workspaceId → null" branch covers the
          // pre-hook-bootstrap edge case only.
          required: false,
          // Clients cannot set `workspaceId` during sign-up — the
          // database hook below mints it server-side. Prevents a
          // malicious signup from landing a user in an existing
          // workspace they don't belong in.
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Runs in the same tx as the user insert. Mints a fresh
          // `workspace_id` for the new user so the row satisfies the
          // `workspaceId` NOT NULL constraint.
          //
          // MVP shape: one workspace per user; each new user gets
          // their own workspace. When multi-workspace lands with an
          // invitation/signup-bootstrap replacement this hook either
          // (a) resolves an existing workspace from invitation context,
          // or (b) mints a new workspace row alongside the user — the
          // editorzero-owned `workspace_members` table still owns the
          // join (see `after` below).
          before: async (user) => ({
            data: {
              ...user,
              workspaceId: generateWorkspaceId(),
            },
          }),
          // **Post-commit bootstrap (ADR 0024).** The resolver is
          // strict-on-missing — a valid session without a
          // `workspace_members` row → 401. This hook lands both
          // anchor rows for the minted workspace: the `workspaces`
          // row (tenant-scope anchor, self-scoped per ADR 0023) and
          // the `workspace_members` row (principal→workspace join).
          // Members row role `"owner"` matches the "user owns the
          // workspace they just minted" invariant.
          //
          // **Ordering: workspaces first.** The auto-appended scope
          // predicate on later reads joins against `workspaces.id`;
          // until the row exists, a scoped handle reading `workspaces`
          // returns empty even for the just-minted id. Inserting the
          // anchor first keeps the two tables in FK-natural order for
          // any observer iterating them.
          //
          // **Runs after commit.** Better Auth's `create.after` fires
          // via `queueAfterTransactionHook` (verified in
          // `@better-auth/core/dist/context/transaction.mjs`) —
          // pending hooks execute after the tx commits. If either
          // insert fails, the error propagates back to the caller of
          // `auth.api.signUpEmail`, which fails loud on signup. The
          // user row is committed but no session exists yet, so
          // recovery requires the caller to delete the orphan user
          // row or use a reconcile job; neither is in scope for the
          // MVP — the current lever is "signup throws, surface to UI,
          // ask user to retry" (bad once, bad rarely; audit log will
          // show the orphaned user + failed audit in the next slice).
          //
          // **Idempotent on conflict.** Both inserts use `doNothing`
          // against their natural uniqueness key (workspaces.id PK;
          // workspace_members composite PK) so a retry that got
          // through BA's internal debounce reconverges rather than
          // double-inserts. `doNothing` is also the revive-in-place-
          // safe variant — a previously-soft-deleted members row
          // stays soft-deleted rather than being silently overwritten
          // by an unrelated re-signup.
          after: async (user) => {
            const workspaceId = (user as { workspaceId?: unknown }).workspaceId;
            if (typeof workspaceId !== "string" || workspaceId.length === 0) {
              // Defensive: `before` always sets workspaceId, so this
              // branch is unreachable in the happy path. If it ever
              // fires it means a future hook chain mutated `user.
              // workspaceId` back out; fail loud rather than silent-
              // 401 later.
              throw new Error(
                "user.create.after: workspaceId missing on user row — before hook did not run or was overridden",
              );
            }
            const wsId = WorkspaceId(workspaceId);
            const now = Date.now();

            // Derive slug/name from the email local-part. Display
            // name is the raw local-part ("alice" from
            // alice@example.com); slug is normalized + deterministic
            // suffix so two Alices in separate workspaces never
            // collide on the partial unique index. Better Auth's
            // email validator guarantees the address contains "@",
            // so `split("@")` always produces ≥ 2 elements — the cast
            // narrows TS's `string | undefined` for index 0 without
            // introducing an untested runtime branch.
            const [localPart] = user.email.split("@") as [string, ...string[]];
            const slug = `${normalizeSlug(localPart)}-${slugSuffix(wsId)}`;
            const displayName = `${localPart}'s workspace`;

            await driver
              .system()
              .insertInto("workspaces")
              .values({
                id: wsId,
                slug,
                name: displayName,
                trash_retention_days: 30,
                diagnostic_salt: randomBytes(16),
                created_by: UserId(user.id),
                created_at: now,
                deleted_at: null,
                settings: "{}",
              })
              .onConflict((oc) => oc.column("id").doNothing())
              .execute();

            await driver
              .system()
              .insertInto("workspace_members")
              .values({
                workspace_id: wsId,
                user_id: UserId(user.id),
                role: "owner",
                created_at: now,
                updated_at: now,
                deleted_at: null,
              })
              .onConflict((oc) => oc.columns(["workspace_id", "user_id"]).doNothing())
              .execute();
          },
        },
      },
    },
  });
}
