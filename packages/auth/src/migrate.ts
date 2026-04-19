/**
 * `runAuthMigrations` — programmatic Better Auth migration runner.
 *
 * Wraps `better-auth/db/migration`'s `getMigrations(options).
 * runMigrations()` so callers don't need to import the migration
 * subpath directly or pass `auth.options` by hand. Used during
 * bootstrap (fresh prod DB) and in test setup (`:memory:` SQLite —
 * the CLI migrator would require a file path, and tests need a
 * per-test isolated DB).
 *
 * **Idempotent.** `getMigrations` inspects the live schema and only
 * emits DDL for missing tables / columns. Calling repeatedly is a
 * no-op once the schema is current. Safe to wire into app startup.
 *
 * **Ordering with editorzero DDL.** Both can run in either order
 * against the shared SQLite DB today — there are no cross-FKs
 * between Better Auth's tables (`user`, `session`, `account`,
 * `verification`) and editorzero's (`docs`, `doc_updates`,
 * `audit_events`, ...). The one bootstrap path owns both: apply
 * editorzero DDL → run Better Auth migrations → accept traffic.
 */

import { getMigrations } from "better-auth/db/migration";

import type { Auth } from "./create-auth";

export async function runAuthMigrations(auth: Auth): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
