import { type Kysely, sql } from "kysely";

import type { SystemDatabase } from "./schema";

/**
 * Count rows in a table that may live outside the typed `SystemDatabase`
 * schema — e.g. Better Auth's `user` table, which coexists in the same
 * SQLite file but is not ours to type (ADR 0010). The identifier goes
 * through `sql.id` (quoted, never string-concatenated). Kept here because
 * raw kysely/`sql` usage is pinned to `packages/db/**`
 * (no-raw-kysely-outside-db); callers receive a number, not a query
 * surface.
 */
export async function countTableRows(db: Kysely<SystemDatabase>, table: string): Promise<number> {
  const result = await sql<{ c: number }>`SELECT count(*) AS c FROM ${sql.id(table)}`.execute(db);
  return result.rows[0]?.c ?? 0;
}
