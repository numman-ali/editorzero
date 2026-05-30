/**
 * `getApiApp` — the production composition root (ADR 0027 / 0029 §8).
 *
 * `createApiApp` (./app) assembles the trunk from *already-constructed*
 * singletons; `getApiApp` is the layer that constructs them — driver,
 * auth (+ migrations), capability registry, sync, dispatcher, role lookup
 * — from runtime config, then calls `createApiApp`. It is the single
 * place the whole stack is wired for a running server; the `serve()`
 * entrypoint (apps/server) and any in-process boot consume it. Until now
 * the only full assembly lived in test `buildStack` helpers — ADR 0027
 * calls extracting it "the genuine first deliverable."
 *
 * **SQLite-only today.** `createAuth` and `createApiDispatcher` are typed
 * to `SqliteDriver`, which matches ADR 0027's single-box deploy floor
 * (trunk + SQLite + embedded Hocuspocus). A Postgres `DATABASE_URL` fails
 * loud — wiring the Postgres backend through the composition root is ADR
 * 0007 dual-backend work, deferred.
 *
 * **Lifecycle.** `close()` tears the stack down in dependency order: sync
 * before driver, because the sync hooks read through the driver and
 * closing the driver first would strand an in-flight read (Explore
 * finding). Idempotent.
 *
 * **Not yet wired** (deliverable #2, the co-hosting smoke): `serveStatic`
 * for the SPA bundle and the `/collab/*` WebSocket upgrade. `getApiApp`
 * returns the bare API trunk; those mount onto it at the serve() layer
 * once the SPA bundle exists and `@hono/node-server` v2 `upgradeWebSocket`
 * + a real `onAuthenticate` land (ADR 0027 / 0030).
 */

import { createAuth, runAuthMigrations } from "@editorzero/auth";
import { createDefaultRegistry } from "@editorzero/capabilities";
import { loadEnvConfig, type RuntimeConfig, resolveSecretRef } from "@editorzero/config";
import {
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createLoadRoles,
  createSqliteDriver,
  ensureSchema,
  type SqliteDriver,
} from "@editorzero/db";
import { HocuspocusSync } from "@editorzero/sync";

import { createApiApp } from "./app";
import { createApiDispatcher } from "./composition/createApiDispatcher";

/**
 * `SecretRef` the Better Auth signing secret is read from when `secret`
 * is not injected. Resolved through the secret layer (`resolveSecretRef`),
 * never `process.env` directly. `BETTER_AUTH_SECRETS` is a rotatable
 * secret in the inventory; a full rotation provider layers on later —
 * boot only needs the current value.
 */
const BETTER_AUTH_SECRET_REF = { mount: "env", env_var: "BETTER_AUTH_SECRET" } as const;

export interface GetApiAppOptions {
  /** Runtime config. Defaults to `loadEnvConfig()` (reads the process env). */
  readonly config?: RuntimeConfig;
  /**
   * Better Auth signing secret (≥32 bytes). Defaults to resolving
   * `BETTER_AUTH_SECRET` through the secret layer. Injected by tests.
   */
  readonly secret?: string;
  /**
   * SQLite driver. Defaults to one opened at `config.database_url`;
   * injected by tests (e.g. an in-memory driver). `ensureSchema` runs
   * against whichever driver is used.
   */
  readonly driver?: SqliteDriver;
  /** MCP `serverInfo`; `createApiApp` supplies a default when omitted. */
  readonly mcpServerInfo?: { readonly name: string; readonly version: string };
}

export interface BootedApp {
  /** The assembled Hono trunk (`AppType`-shaped). */
  readonly app: ReturnType<typeof createApiApp>;
  /** The SQLite driver the stack is bound to. */
  readonly driver: SqliteDriver;
  /** The embedded sync service (headless Hocuspocus). */
  readonly sync: HocuspocusSync;
  /** Tear down sync then driver, in dependency order. Idempotent. */
  readonly close: () => Promise<void>;
}

/**
 * Map a `database_url` to a SQLite file path. SQLite-only at the
 * composition root (see file header); a Postgres URL fails loud rather
 * than letting `createSqliteDriver` try to open a file literally named
 * `postgres://…`.
 */
function sqlitePath(databaseUrl: string): string {
  if (/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    throw new Error(
      "getApiApp: DATABASE_URL is a Postgres URL, but the composition root is SQLite-only " +
        "today (createAuth / createApiDispatcher are typed to SqliteDriver; ADR 0027 deploy " +
        "floor is trunk + SQLite). Wiring the Postgres backend through the composition root is " +
        'ADR 0007 dual-backend work, deferred. Set DATABASE_URL to a SQLite file path or ":memory:".',
    );
  }
  return databaseUrl;
}

export async function getApiApp(options: GetApiAppOptions = {}): Promise<BootedApp> {
  const config = options.config ?? loadEnvConfig();
  const driver = options.driver ?? createSqliteDriver({ path: sqlitePath(config.database_url) });

  // Schema first — the Better Auth user-create hook inserts into our
  // `workspaces` / `workspace_members` tables, so they must exist before
  // auth runs — then Better Auth's own migrations. ensureSchema is
  // restart-safe; runAuthMigrations is idempotent. Both complete before
  // the trunk accepts a request.
  ensureSchema(driver);
  const secret = options.secret ?? (await resolveSecretRef(BETTER_AUTH_SECRET_REF));
  const auth = createAuth({
    driver,
    baseURL: config.public_origin,
    secret,
    trustedOrigins: [config.public_origin],
  });
  await runAuthMigrations(auth);

  const registry = createDefaultRegistry();
  const sync = new HocuspocusSync({
    docUpdatesWriter: createDocUpdatesWriter(),
    docUpdatesReader: createDocUpdatesReader(),
    systemDb: driver.system(),
  });
  const dispatcher = createApiDispatcher({ driver, registry, sync });
  const loadRoles = createLoadRoles(driver);

  const app = createApiApp({
    auth,
    loadRoles,
    dispatcher,
    registry,
    ...(options.mcpServerInfo !== undefined && { mcpServerInfo: options.mcpServerInfo }),
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await sync.close();
    await driver.close();
  };

  return { app, driver, sync, close };
}
