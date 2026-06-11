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

import type { AuditEffect, AuditWriteInput } from "@editorzero/audit";
import { asAuditTx, countTableRows, createAuditWriter, type SqliteDriver } from "@editorzero/db";
import { CapabilityId, generateWorkspaceId, UserId, uuidV7, WorkspaceId } from "@editorzero/ids";
import { SYSTEM_WORKSPACE_BOOTSTRAP } from "@editorzero/scopes";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * Lowercased, non-alphanumeric collapsed to single dash, trimmed,
 * capped at 40 chars. Used as the human-readable prefix of the
 * workspace slug; paired with `slugSuffix` to produce a deterministic
 * unique slug. May return an empty string (e.g. `"+++"` → `""`);
 * callers must guard that case — `"-{suffix}"` would leak a leading
 * hyphen into the slug and partial-index-based uniqueness would still
 * allow it but the URL shape is ugly.
 */
function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Deterministic hex suffix derived from the workspace id via SHA-256.
 * 12 hex = 48 bits of entropy; for common email local-parts like
 * `admin` / `info` / `support` shared across many workspaces, 6 hex
 * (24 bits) would see ~50% birthday-paradox collision risk at ~5k
 * shared-prefix signups (Codex review). At 48 bits the same risk
 * sits at ~20M shared-prefix signups — beyond any realistic scale.
 * Collisions matter here because they would raise a UNIQUE violation
 * inside the post-commit hook, stranding a committed BA `user` row
 * without a matching workspace (fail-loud-on-signup, but painful).
 *
 * Deterministic-over-random for the usual reason: reproducible test
 * fixtures and no retry loop.
 */
function slugSuffix(workspaceId: WorkspaceId): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
}

/**
 * Compose the final slug — handles the empty-prefix case with a
 * `workspace-` fallback so the slug never starts with a hyphen.
 * Separated from the `slug = ...` line at the call-site so the
 * fallback rule is visibly colocated with `normalizeSlug`'s
 * "may-be-empty" contract. Exported for unit coverage of the
 * fallback branch — an email local-part that normalizes to empty is
 * hard to produce through a real Better Auth signup because the
 * email validator rejects most shapes that would trigger it.
 */
export function composeWorkspaceSlug(localPart: string, workspaceId: WorkspaceId): string {
  const prefix = normalizeSlug(localPart);
  const suffix = slugSuffix(workspaceId);
  return prefix.length > 0 ? `${prefix}-${suffix}` : `workspace-${suffix}`;
}

// ── Genesis audit (ADR 0041) ───────────────────────────────────────────────
//
// Signup bootstrap writes the `workspaces` anchor + owner `workspace_members`
// row OUTSIDE the dispatcher, so each needs an audit row carrying a non-dispatch
// provenance marker to keep invariant 3 whole (the log alone reconstructs final
// state). The marker is `system.workspace_bootstrap` (`@editorzero/scopes`,
// coherence-validated disjoint from real capabilities). Reusing the shared
// `AuditWriter` keeps the `audit_events` row shape + its paired
// `outbox(audit.appended)` fan-out single-sourced rather than hand-rolled.
const BOOTSTRAP_CAPABILITY_ID = CapabilityId(SYSTEM_WORKSPACE_BOOTSTRAP);
const bootstrapAuditWriter = createAuditWriter();

/**
 * Build a genesis `AuditWriteInput`. Principal = the signing-up user; no
 * session / token / acting-as (the user is mid-creation). `input_hash`
 * fingerprints the effect's canonical JSON — genesis has no dispatch input, but
 * the column is NOT NULL and a deterministic, content-identifying value is the
 * honest analog.
 */
function bootstrapAuditRow(params: {
  workspace_id: WorkspaceId;
  user_id: UserId;
  subject_kind: "workspace" | "user";
  subject_id: string | null;
  effect: AuditEffect;
}): AuditWriteInput {
  return {
    workspace_id: params.workspace_id,
    capability_id: BOOTSTRAP_CAPABILITY_ID,
    category: "mutation",
    principal_kind: "user",
    principal_id: params.user_id,
    acting_as_user_id: null,
    session_id: null,
    token_id: null,
    subject_kind: params.subject_kind,
    subject_id: params.subject_id,
    input_hash: createHash("sha256").update(JSON.stringify(params.effect)).digest("hex"),
    duration_ms: 0,
    trace_id: null,
    collapsed_count: 1,
    record: { outcome: "allow", effect: params.effect },
  };
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
  /**
   * Registration policy (config `registration_mode`; Codex 2026-06-11
   * HIGH). `first-user` permits exactly the genesis sign-up — the
   * ADR 0041 audited bootstrap — and closes `/auth/sign-up/email`
   * the moment any `user` row exists; `open` is the dev/test/demo
   * posture. Required (no default) so every composition root and
   * test chooses its posture explicitly; the deployment default
   * (`first-user`) lives in `@editorzero/config`.
   */
  readonly registrationMode: "first-user" | "open";
}

export function createAuth(options: CreateAuthOptions) {
  const { driver, baseURL, secret, trustedOrigins, registrationMode } = options;

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
    hooks: {
      // Registration gate (server-side — the sign-up form is UX, not
      // enforcement; Codex 2026-06-11 HIGH). Request-level rather than
      // `databaseHooks.user.create.before` deliberately: the database
      // hook runs inside Better Auth's adapter transaction, which holds
      // the single pooled SQLite connection — a count query through
      // `driver.system()` there deadlocks (empirically, 2026-06-11).
      // Here the request hasn't opened the tx yet. The count→insert
      // pair is policy, not a uniqueness constraint: two genesis
      // sign-ups racing a fresh install could both pass, each landing
      // in its own workspace — harmless on a private box, and the
      // invite slice replaces this ceiling anyway.
      before: createAuthMiddleware(async (ctx) => {
        if (registrationMode !== "first-user" || ctx.path !== "/sign-up/email") {
          return;
        }
        if ((await countTableRows(driver.system(), "user")) > 0) {
          throw new APIError("FORBIDDEN", {
            message: "Registration is closed. Ask the instance owner for an invite.",
          });
        }
      }),
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
          // ask user to retry" (bad once, bad rarely). The genesis
          // writes + their two audit rows are one atomic tx (ADR 0041),
          // so a failure leaves only the orphan BA `user` row — no
          // partial workspace, and no orphan audit.
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
            // alice@example.com); slug is `composeWorkspaceSlug`
            // which handles the empty-prefix fallback. Better Auth's
            // email validator guarantees the address contains "@",
            // so `split("@")` always produces ≥ 2 elements — the cast
            // narrows TS's `string | undefined` for index 0 without
            // introducing an untested runtime branch.
            const [localPart] = user.email.split("@") as [string, ...string[]];
            const slug = composeWorkspaceSlug(localPart, wsId);
            const displayName = `${localPart}'s workspace`;

            const userId = UserId(user.id);

            // **Post-commit app bootstrap transaction (ADR 0041).** This
            // `withSystemTx` makes the genesis tuple — `workspaces` +
            // `workspace_members` + their two audit rows — atomic AMONG
            // THEMSELVES, closing invariant 3 for signup (replay reconstructs
            // the root workspace + owner from the log alone). It is NOT atomic
            // with the already-committed BA `user` row: the user-without-
            // workspace gap above is unchanged. Each audit row emits ONLY when
            // its insert actually mutated — `.onConflict().doNothing()` returns
            // no row on a debounced retry-collision — so "exactly one audit
            // entry per mutation" holds across retries rather than double-
            // auditing. Reuses the shared `AuditWriter` (row shape + the
            // `outbox(audit.appended)` fan-out are single-sourced).
            await driver.withSystemTx(async (tx) => {
              const wsRow = await tx
                .insertInto("workspaces")
                .values({
                  id: wsId,
                  slug,
                  name: displayName,
                  trash_retention_days: 30,
                  diagnostic_salt: randomBytes(16),
                  created_by: userId,
                  created_at: now,
                  deleted_at: null,
                  settings: "{}",
                })
                .onConflict((oc) => oc.column("id").doNothing())
                .returning("id")
                .executeTakeFirst();

              const memberRow = await tx
                .insertInto("workspace_members")
                .values({
                  workspace_id: wsId,
                  user_id: userId,
                  role: "owner",
                  created_at: now,
                  updated_at: now,
                  deleted_at: null,
                })
                .onConflict((oc) => oc.columns(["workspace_id", "user_id"]).doNothing())
                .returning("workspace_id")
                .executeTakeFirst();

              if (wsRow !== undefined) {
                await bootstrapAuditWriter.write(
                  asAuditTx(tx),
                  bootstrapAuditRow({
                    workspace_id: wsId,
                    user_id: userId,
                    subject_kind: "workspace",
                    subject_id: null,
                    // `settings: {}` is the parsed form of the stored "{}" — the
                    // workspace.create effect carries the parsed object (the
                    // #25 round-trip rule); genesis settings is always empty.
                    effect: {
                      kind: "workspace.create",
                      workspace_id: wsId,
                      slug,
                      name: displayName,
                      created_by: userId,
                      trash_retention_days: 30,
                      settings: {},
                    },
                  }),
                );
              }

              if (memberRow !== undefined) {
                await bootstrapAuditWriter.write(
                  asAuditTx(tx),
                  bootstrapAuditRow({
                    workspace_id: wsId,
                    user_id: userId,
                    subject_kind: "user",
                    subject_id: userId,
                    effect: {
                      kind: "member.add",
                      workspace_id: wsId,
                      user_id: userId,
                      role: "owner",
                    },
                  }),
                );
              }
            });
          },
        },
      },
    },
  });
}
