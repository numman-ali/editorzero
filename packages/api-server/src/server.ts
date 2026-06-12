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
 * **WS attach wired here (ADR 0030 hardening).** The collab WebSocket
 * authorization policy is composed in this root and handed to
 * `HocuspocusSync` as `collabAuthorize` — WS clients therefore attach to
 * the SAME embedded Hocuspocus the dispatcher writes through (live
 * convergence: HTTP `ctx.transact` broadcasts to attached clients), and
 * per-document authZ runs per Auth frame with a FRESH principal resolve
 * (revocation freshness — nothing identity-shaped is snapshotted on the
 * socket). The upgrade-time boundary (path, Origin allow-list, early
 * cookie check) lives in `attachCollab` (apps/server), mounted by the
 * production entrypoint next to `attachSpa`.
 */

import {
  type BetterAuthResolver,
  createAuth,
  createBetterAuthResolver,
  runAuthMigrations,
} from "@editorzero/auth";
import { createDefaultRegistry, loadDocReadResolver } from "@editorzero/capabilities";
import { loadEnvConfig, type RuntimeConfig, resolveSecretRef } from "@editorzero/config";
import {
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createLoadRoles,
  createSqliteDriver,
  ensureSchema,
  type SqliteDriver,
} from "@editorzero/db";
import { effectiveScopes, workspaceAwareGate } from "@editorzero/dispatcher";
import { DocId } from "@editorzero/ids";
import { type Logger, noopLogger } from "@editorzero/observability";
import { type CollabAuthorizePayload, HocuspocusSync } from "@editorzero/sync";

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
  /**
   * Structured logger for composition-root concerns (today: collab
   * WS authorization denials). Defaults to `noopLogger` — the
   * production entrypoint passes its `consoleLogger`.
   */
  readonly logger?: Logger;
}

export interface BootedApp {
  /** The assembled Hono trunk (`AppType`-shaped). */
  readonly app: ReturnType<typeof createApiApp>;
  /** The SQLite driver the stack is bound to. */
  readonly driver: SqliteDriver;
  /** The embedded sync service (headless Hocuspocus). */
  readonly sync: HocuspocusSync;
  /**
   * Principal resolver (`(headers) => UserPrincipal | null`) over the
   * *same* Better Auth instance the trunk uses. Exposed so the collab
   * WebSocket upgrade can authenticate the session cookie through one
   * shared resolver rather than re-implementing identity (ADR 0030,
   * invariant 5). The trunk's principal middleware builds its own from
   * the same `auth` + `loadRoles`; production unification onto a single
   * resolver instance is the ADR 0027 WS-attach-hook pass.
   */
  readonly resolver: BetterAuthResolver;
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
    registrationMode: config.registration_mode,
  });
  await runAuthMigrations(auth);

  const registry = createDefaultRegistry();
  const logger = options.logger ?? noopLogger;
  // One role source, two consumers (ADR 0040 Step 6): the auth
  // resolver turns sessions into principals with `loadRoles`, and the
  // production gate uses the SAME callable to resolve a delegated
  // agent's `acting_as` user at check time — the H8 intersection.
  const loadRoles = createLoadRoles(driver);
  const resolver = createBetterAuthResolver({ auth, loadRoles });

  /**
   * Per-document WS authorization (ADR 0030 blockers 1–3). Runs once
   * per (socket, documentName) Auth frame; ANY throw denies that one
   * document attach — Hocuspocus answers a generic `permission-denied`
   * frame, so refusal reasons stay server-side (the structured warn
   * below is the observable channel).
   *
   * Authority = the same two terms the dispatcher gate would apply to
   * `doc.get`, REUSED not re-implemented (invariant 5): the gate's
   * `effectiveScopes` arithmetic (`doc:read`), then the Step-6 ceiling
   * (`loadDocReadResolver(...).assertCanRead`) on the live doc row.
   * The principal is re-resolved from the upgrade request's headers on
   * EVERY frame — session revoked after the socket opened ⇒ the next
   * document attach is denied; nothing is trusted from connection
   * context. Cookie-path = user principals only: `effectiveScopes`
   * takes an agent token's scope claim verbatim (the live H8
   * intersection lives in `workspaceAwareGate`), so an agent-capable
   * WS path must come back for the H8-aware term (slice B).
   *
   * Soft-deleted docs deny: live collaboration on a trashed doc is not
   * a state the product has — restore first (ADR 0017's recovery
   * capability is the sanctioned route back).
   */
  const collabAuthorize = async ({
    documentName,
    requestHeaders,
  }: CollabAuthorizePayload): Promise<void> => {
    try {
      const headers = new Headers();
      if (typeof requestHeaders.cookie === "string") {
        headers.set("cookie", requestHeaders.cookie);
      }
      const principal = await resolver(headers);
      if (principal === null) {
        throw new Error("collab: no authenticated session");
      }
      if (principal.kind !== "user") {
        throw new Error("collab: cookie path admits user principals only");
      }
      if (!effectiveScopes(principal).has("doc:read")) {
        throw new Error("collab: principal lacks doc:read");
      }
      const doc_id = DocId(documentName);
      const scoped = driver.scoped(principal.workspace_id);
      const doc = await scoped
        .selectFrom("docs")
        .select(["id", "created_by", "access_mode", "collection_id", "deleted_at"])
        .where("id", "=", doc_id)
        .executeTakeFirst();
      if (doc === undefined || doc.deleted_at !== null) {
        throw new Error("collab: document not found in principal workspace");
      }
      const acl = await loadDocReadResolver(scoped, principal);
      acl.assertCanRead(doc);
    } catch (error) {
      logger.warn("collab attach denied", {
        event: "hocuspocus.authenticate",
        "collab.document": documentName,
        "collab.reason": error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const sync = new HocuspocusSync({
    docUpdatesWriter: createDocUpdatesWriter(),
    docUpdatesReader: createDocUpdatesReader(),
    systemDb: driver.system(),
    collabAuthorize,
  });
  const dispatcher = createApiDispatcher({
    driver,
    registry,
    sync,
    gate: workspaceAwareGate({ loadDelegatorRoles: loadRoles }),
  });

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

  return { app, driver, sync, resolver, close };
}
