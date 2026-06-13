/**
 * Backend abstraction for the dual-dialect conformance harness
 * (ADR 0007 §"Dual storage" / ADR 0023 §4).
 *
 * The driver shapes diverge on exec-sync-vs-async and on the
 * dialect-specific getters (`pragma` vs `setting`). Tests that must
 * behave identically on both dialects depend only on the subset the
 * two drivers agree on — `scoped`, `system`, `withSystemTx`, `close` —
 * which this module packages as `ConformanceDriver`.
 *
 * Container strategy for Postgres mirrors `postgres.unit.test.ts`: one
 * `PostgreSqlContainer` per *file* via a shared factory, and each
 * `beforeEach` resets the schema by dropping + re-applying `FULL_DDL`.
 * The SQLite side uses `:memory:`, so reset is free.
 *
 * Skip guard: `EDITORZERO_SKIP_POSTGRES_TESTS=1` disables the Postgres
 * backend, leaving SQLite as the only parametrization. Developers
 * without Docker can still run the conformance suite against SQLite.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Kysely, Transaction } from "kysely";
import { createPostgresDriver, type PostgresDriver } from "../../src/drivers/postgres";
import { FULL_DDL as POSTGRES_FULL_DDL } from "../../src/drivers/postgres-ddl";
import { createSqliteDriver, type SqliteDriver } from "../../src/drivers/sqlite";
import { FULL_DDL as SQLITE_FULL_DDL } from "../../src/drivers/sqlite-ddl";
import type { SystemDatabase } from "../../src/schema";
import type { TenantScopedDb } from "../../src/tenant";

// Bracket access: tsconfig's `noPropertyAccessFromIndexSignature` (TS4111)
// forbids `process.env.FOO`.
export const SKIP_POSTGRES = process.env["EDITORZERO_SKIP_POSTGRES_TESTS"] === "1";

/**
 * Pinned image per ADR 0023 §2. Kept in sync with
 * `postgres.unit.test.ts`; when one moves, the other follows.
 */
const POSTGRES_IMAGE = "postgres:17.4-bookworm";

/**
 * Subset of the driver contract both dialects agree on. Tests that
 * must be dialect-agnostic constrain themselves to this shape.
 *
 * `exec` is async here — the Postgres driver is async-native; the
 * SQLite driver's sync `exec` is adapted by `await` with a resolved
 * promise, because `await` on a non-promise is a no-op.
 */
export interface ConformanceDriver {
  scoped(workspace_id: import("@editorzero/ids").WorkspaceId): TenantScopedDb;
  system(): Kysely<SystemDatabase>;
  withSystemTx<T>(fn: (tx: Transaction<SystemDatabase>) => Promise<T>): Promise<T>;
}

export interface Backend {
  readonly name: "sqlite" | "postgres";
  readonly driver: ConformanceDriver;
  /** Rewipe the schema — DROP every table then re-apply dialect DDL. */
  readonly resetSchema: () => Promise<void>;
  /** Release resources — pool drain (pg) or connection close (sqlite). */
  readonly close: () => Promise<void>;
}

const DROP_TABLES_SQL = `
  DROP TABLE IF EXISTS agent_tokens;
  DROP TABLE IF EXISTS agents;
  DROP TABLE IF EXISTS grants;
  DROP TABLE IF EXISTS space_members;
  DROP TABLE IF EXISTS spaces;
  DROP TABLE IF EXISTS outbox;
  DROP TABLE IF EXISTS audit_events;
  DROP TABLE IF EXISTS doc_counters;
  DROP TABLE IF EXISTS doc_updates;
  DROP TABLE IF EXISTS doc_snapshots;
  DROP TABLE IF EXISTS workspace_members;
  DROP TABLE IF EXISTS docs;
  DROP TABLE IF EXISTS collections;
  DROP TABLE IF EXISTS workspaces;
`;

export async function createSqliteBackend(): Promise<Backend> {
  const driver: SqliteDriver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
  return {
    name: "sqlite",
    driver,
    resetSchema: async () => {
      driver.exec(DROP_TABLES_SQL);
      driver.exec(SQLITE_FULL_DDL);
    },
    close: async () => {
      await driver.close();
    },
  };
}

/**
 * Starts a Postgres container and returns a backend bound to it.
 *
 * First call in a test file pulls the `postgres:17.4-bookworm` image
 * if it's not cached locally — budget ~30s on a cold Docker. Subsequent
 * calls in the same file reuse the container; each test uses
 * `resetSchema` to wipe + re-apply the DDL for determinism.
 */
export async function createPostgresBackend(): Promise<{
  backend: Backend;
  container: StartedPostgreSqlContainer;
}> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase("editorzero_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  const driver: PostgresDriver = createPostgresDriver({
    connectionString: container.getConnectionUri(),
  });
  await driver.exec(POSTGRES_FULL_DDL);
  return {
    backend: {
      name: "postgres",
      driver,
      resetSchema: async () => {
        await driver.exec(DROP_TABLES_SQL);
        await driver.exec(POSTGRES_FULL_DDL);
      },
      close: async () => {
        await driver.close();
        await container.stop();
      },
    },
    container,
  };
}
