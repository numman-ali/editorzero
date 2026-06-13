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

import { createAuth, createBetterAuthResolver, runAuthMigrations } from "@editorzero/auth";
import { createDefaultRegistry } from "@editorzero/capabilities";
import { loadEnvConfig, type RuntimeConfig, resolveSecretRef } from "@editorzero/config";
import {
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createLoadRoles,
  createResolveAgentToken,
  createSqliteDriver,
  ensureSchema,
  type SqliteDriver,
} from "@editorzero/db";
import { workspaceAwareGate } from "@editorzero/dispatcher";
import { type Logger, noopLogger } from "@editorzero/observability";
import { HocuspocusSync } from "@editorzero/sync";

import { createApiApp } from "./app";
import { createCollabPolicies } from "./composition/collabPolicies";
import { type CollabSocketRegistry, createCollabSocketRegistry } from "./composition/collabSockets";
import { createApiDispatcher } from "./composition/createApiDispatcher";
import { createRateLimiter, type RateLimiter, withRateLimit } from "./composition/rateLimit";
import { createRevocationTap, withRevocationTap } from "./composition/revocationTap";
import {
  type ComposedPrincipalResolver,
  createComposedPrincipalResolver,
} from "./middleware/agent-bearer";

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
  /**
   * WS connection write posture, threaded to
   * `HocuspocusSyncDeps.collabReadOnly`. DEFAULT FALSE (lifted) — the
   * ADR 0043 write lane is the production posture: every novel WS
   * frame dispatches `doc.apply_update` through the audited gate, and
   * the socket registry + revocation tap (Decision 5, wired below)
   * close revoked standing. TRUE is the operator's emergency
   * read-only pin: attaches succeed but every WS write keeps the
   * native nacked-not-applied contract.
   */
  readonly collabReadOnly?: boolean;
  /**
   * The pre-dispatch rate limiter (ADR 0044 Decision 6). Defaults to
   * `createRateLimiter({ logger })` — the in-memory token-bucket limiter
   * with agents throttled tighter than users (invariant 8). Injected by
   * tests: a tight limiter to exercise the 429-at-the-door path, or a
   * permissive `{ consume: () => ({ allowed: true }) }` for suites that
   * fire many same-principal dispatches and are not testing throttling.
   */
  readonly rateLimiter?: RateLimiter;
}

export interface BootedApp {
  /** The assembled Hono trunk (`AppType`-shaped). */
  readonly app: ReturnType<typeof createApiApp>;
  /** The SQLite driver the stack is bound to. */
  readonly driver: SqliteDriver;
  /** The embedded sync service (headless Hocuspocus). */
  readonly sync: HocuspocusSync;
  /**
   * The composed bearer+cookie principal resolver (`(headers) =>
   * Principal | null`) the collab WS surface authenticates through — a
   * session cookie → human, an `Authorization: Bearer ez_agent_…` →
   * api-key agent (ADR 0044 Decision 5 step 2). Exposed so `attachCollab`
   * (apps/server) resolves the upgrade with the SAME core the per-frame
   * policy and the HTTP principal middleware use — one identity source,
   * no accidental cookie-only collab path (Codex SF2). Renamed from the
   * old cookie-only `resolver` to make the composed nature explicit at
   * the seam.
   */
  readonly collabPrincipalResolver: ComposedPrincipalResolver;
  /**
   * Collab socket registry (ADR 0043 Decision 5). `attachCollab`
   * (apps/server) registers every upgraded WS under the identity it
   * resolved at upgrade; the revocation tap (wrapped around the
   * dispatcher here) and the sign-out arm (`onAuthRevoked` on the
   * trunk) close affected entries when standing changes.
   */
  readonly collabSockets: CollabSocketRegistry;
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
  const cookieResolver = createBetterAuthResolver({ auth, loadRoles });
  // Owned agent bearer lookup (ADR 0044 Decision 4) — ONE instance shared
  // by the HTTP principal middleware (handed to `createApiApp` below) and
  // the collab composed resolver here (Decision 5 step 2).
  const resolveAgentToken = createResolveAgentToken(driver);
  /**
   * The composed bearer+cookie principal resolver (ADR 0044 Decision 5
   * step 2 / Codex SF2) — the SAME header-shaped core the HTTP principal
   * middleware mounts. The collab WS surface resolves identity through
   * THIS at both seams — `attachCollab`'s upgrade gate (via
   * `BootedApp.collabPrincipalResolver`) and the per-frame policies — so
   * attach standing, per-frame write authority, and the HTTP surface can
   * never diverge on who a request is.
   */
  const collabPrincipalResolver = createComposedPrincipalResolver({
    resolveAgentToken,
    cookieResolve: cookieResolver,
  });

  /**
   * Both collab WS policies — attach standing (`onAuthenticate`) and
   * the per-frame write dispatch (the `beforeHandleMessage` gate, ADR
   * 0043 Decision 3) — built in `composition/collabPolicies.ts` on the
   * one shared composed resolve. The dispatcher is late-bound below:
   * sync must exist before the dispatcher that writes through it.
   */
  const collab = createCollabPolicies({
    resolvePrincipal: collabPrincipalResolver,
    driver,
    logger,
  });

  const sync = new HocuspocusSync({
    docUpdatesWriter: createDocUpdatesWriter(),
    docUpdatesReader: createDocUpdatesReader(),
    systemDb: driver.system(),
    collabAuthorize: collab.collabAuthorize,
    collabApplyUpdate: collab.collabApplyUpdate,
    ...(options.collabReadOnly !== undefined && { collabReadOnly: options.collabReadOnly }),
    logger,
  });
  // Revocation tap (ADR 0043 Decision 5): every successful dispatch —
  // HTTP, MCP, and the WS write lane alike — flows through
  // `withRevocationTap`, which closes the affected subject's collab
  // sockets after a revoke-class capability commits. The registry is
  // populated by `attachCollab` (apps/server) at upgrade time.
  const collabSockets = createCollabSocketRegistry();
  // Composition order, OUTSIDE-IN: `withRateLimit` is the outermost wrap
  // — the rate gate fires at the door (ADR 0044 Decision 6), before the
  // revocation tap, the dispatcher's gate/handler, and the audit pipeline,
  // so a 429 mutates nothing and writes no audit row. Inside it,
  // `withRevocationTap` closes the affected subject's collab sockets after
  // a revoke-class capability commits (ADR 0043 Decision 5). The collab
  // write lane dispatches through this SAME wrapped value (wired below), so
  // an agent flooding `doc.apply_update` frames hits the agent bucket too.
  const dispatcher = withRateLimit(
    withRevocationTap(
      createApiDispatcher({
        driver,
        registry,
        sync,
        gate: workspaceAwareGate({ loadDelegatorRoles: loadRoles }),
      }),
      createRevocationTap({
        registry: collabSockets,
        driver,
        logger,
        // doc.delete closes the trashed doc's ROOM (per-document
        // connections at the sync layer), not user sockets.
        closeDocConnections: (docId) => sync.closeDocumentConnections(docId),
      }),
    ),
    options.rateLimiter ?? createRateLimiter({ logger }),
  );
  collab.wireDispatcher(dispatcher);

  const app = createApiApp({
    auth,
    loadRoles,
    dispatcher,
    registry,
    // ADR 0044 Decision 4 — the HTTP/MCP principal chain's owned agent
    // bearer arm. The SAME `resolveAgentToken` instance backs the collab
    // composed resolver above (Decision 5 step 2): one lookup seam, every
    // surface.
    resolveAgentToken,
    ...(options.mcpServerInfo !== undefined && { mcpServerInfo: options.mcpServerInfo }),
    // Sign-out arm of the same tap: Better Auth owns session
    // destruction, so the `/auth/*` mount reports it and the registry
    // closes whatever the revoked standing was carrying.
    onAuthRevoked: (revocation) => {
      const closed =
        revocation.kind === "session"
          ? collabSockets.closeBySession(revocation.session_id)
          : collabSockets.closeByUser(revocation.user_id);
      if (closed > 0) {
        logger.info("collab sockets closed after auth revocation", {
          event: "session.revoke_close",
          "collab.sockets_closed": closed,
        });
      }
    },
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await sync.close();
    await driver.close();
  };

  return { app, driver, sync, collabPrincipalResolver, collabSockets, close };
}
