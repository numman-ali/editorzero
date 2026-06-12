/**
 * Conflict targets for partial unique indexes.
 *
 * SQLite (and Postgres) match an `ON CONFLICT` target to a PARTIAL
 * unique index statically at prepare time, so the target's WHERE
 * clause must mirror the index predicate with INLINE literals — a
 * bound `?` can never be proven equal to the index's `'personal'`,
 * and the prepare fails with "ON CONFLICT clause does not match any
 * PRIMARY KEY or UNIQUE constraint". `sql.lit` is the escape hatch,
 * and the no-raw-kysely-outside-db rule keeps that hatch HERE, next
 * to the schema that defines the index — if the index predicate ever
 * changes, this file is the one place the conflict target changes
 * with it.
 */

import { type OnConflictBuilder, type OnConflictDoNothingBuilder, sql } from "kysely";

import type { Database } from "./schema";

/**
 * `DO NOTHING` keyed on `spaces_personal_unique` — the partial unique
 * index `(workspace_id, owner_user_id) WHERE kind = 'personal' AND
 * deleted_at IS NULL` (see `SPACES_DDL`). The signup bootstrap relies
 * on this for idempotent Personal-space seeding: a debounced retry
 * mints a DIFFERENT space id, so the PK target would never collide —
 * only the index-backed target dedupes the re-seed.
 */
export function onConflictPersonalSpaceDoNothing(
  oc: OnConflictBuilder<Database, "spaces">,
): OnConflictDoNothingBuilder<Database, "spaces"> {
  return oc
    .columns(["workspace_id", "owner_user_id"])
    .where("kind", "=", sql.lit("personal"))
    .where("deleted_at", "is", null)
    .doNothing();
}
