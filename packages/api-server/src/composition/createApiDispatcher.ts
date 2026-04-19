/**
 * `createApiDispatcher` — dispatcher composition root for the API trunk
 * (architecture.md §6.1, ADR 0018, ADR 0023).
 *
 * The dispatcher is the single orchestration path between surface
 * adapters and capability handlers. Every surface consumes the same
 * `Dispatcher` value; this factory builds it against a concrete driver
 * + registry so the trunk can hold one process-scoped instance.
 *
 * **Why this lives in api-server rather than `@editorzero/dispatcher`.**
 * `packages/dispatcher` owns the orchestration semantics (parse → gate
 * → invoke → parse → audit, write-path tx rollback shape, audit
 * projection). It takes `runInWriteTx` / `runRead` / `withAuditTx` as
 * injected dependencies because those mechanics vary by deployment
 * posture — the exact shape used here (tenant-scoped `ctx.db` derived
 * from `principal.workspace_id`, `AuditTx` from `asAuditTx(tx)`,
 * `transact` stub until `@editorzero/sync` integration lands for
 * content mutations) is a *deployment* decision, not a *dispatcher*
 * decision. So the factory that makes those choices lives where the
 * trunk lives.
 *
 * **Driver parameter is `SqliteDriver` today; widens to `SqliteDriver
 * | PostgresDriver` once Postgres integration lands in a follow-up
 * slice** (ADR 0023). The driver surface (`.withSystemTx`, `.system()`,
 * `.scoped()`) is the same across both; this factory reads only that
 * surface, not SQLite-specific bits, so the widening is mechanical.
 *
 * **`transact` is stubbed to throw.** Content-mutation capabilities
 * (`doc.create`, `doc.update`, etc.) need `ctx.transact(doc_id, fn)` to
 * run against a Hocuspocus-bound `BoundSyncService`. That binding is a
 * runtime concern of this composition root, but wiring it here couples
 * the first-capability-route slice to Hocuspocus boot — which has its
 * own lifecycle (open once per app, close on shutdown). Landing the
 * stub here means metadata-only capabilities work today; the content-
 * mutation slice replaces the stub with the real `BoundSyncService.
 * transact` binding and lands together with route tests that exercise
 * `doc.create`'s seed-blocks path.
 *
 * **`now: () => Date.now()` default** keeps tests deterministic by
 * letting them override with a fake clock. Production inherits the
 * real wall clock; observability spans read the same `now` so the
 * audit row's timestamp agrees with the span's start time.
 */

import type { AuditWriter } from "@editorzero/audit";
import type { Registry } from "@editorzero/capabilities";
import {
  asAuditTx,
  createAuditWriter,
  createTenantScopedDb,
  type SqliteDriver,
} from "@editorzero/db";
import {
  type CapabilityContextExtras,
  createDispatcher,
  type Dispatcher,
  type PermissionGate,
  scopeOnlyGate,
} from "@editorzero/dispatcher";
import { type Logger, noopLogger, noopTracer, type Tracer } from "@editorzero/observability";

export interface CreateApiDispatcherOptions {
  readonly driver: SqliteDriver;
  readonly registry: Registry;
  /**
   * Permission gate. Defaults to `scopeOnlyGate()` — scope-only deny
   * logic, no workspace/ownership checks. The `workspaceAwareGate`
   * that layers role + workspace membership checks lands once the
   * `workspace_members` table + gate slice ship; it slots into this
   * seam without touching the rest of the factory.
   */
  readonly gate?: PermissionGate;
  /** Defaults to `createAuditWriter()` from `@editorzero/db`. */
  readonly auditWriter?: AuditWriter;
  readonly logger?: Logger;
  readonly tracer?: Tracer;
  /** Defaults to `Date.now`. Tests override for deterministic timestamps. */
  readonly now?: () => number;
}

export function createApiDispatcher(options: CreateApiDispatcherOptions): Dispatcher {
  const {
    driver,
    registry,
    gate = scopeOnlyGate(),
    auditWriter = createAuditWriter(),
    logger = noopLogger,
    tracer = noopTracer,
    now = () => Date.now(),
  } = options;

  return createDispatcher({
    registry,
    gate,
    auditWriter,
    tracer,
    logger,
    now,
    runInWriteTx: async (principal, fn) =>
      driver.withSystemTx(async (tx) => {
        const extras: CapabilityContextExtras = {
          db: createTenantScopedDb(tx, principal.workspace_id),
          // Outbox writes are tx-local in the real (P3.6c) wiring;
          // placeholder here until the sync-service integration slice
          // replaces the stub with `ctx.outbox(event)` →
          // `INSERT INTO outbox (..., tx=<current>)`.
          // biome-ignore lint/suspicious/noEmptyBlockStatements: deliberate no-op stub — see comment above.
          outbox: () => {},
          // Stubbed until the sync-service (Hocuspocus `BoundSyncService`)
          // wiring lands in the content-mutation slice. Every capability
          // registered for content mutations (ADR 0018) will expect this
          // to resolve against a live Y.Doc; throwing here keeps the
          // failure mode loud (capability handler sees a real error it
          // can project to `HandlerError`, not a silent no-op).
          transact: async () => {
            throw new Error(
              "createApiDispatcher: ctx.transact is not wired yet — content-mutation " +
                "capabilities need the Hocuspocus BoundSyncService slice to land. " +
                "Metadata-only capabilities do not call transact.",
            );
          },
        };
        return fn(extras, asAuditTx(tx));
      }),
    runRead: async (principal, fn) => {
      const extras: CapabilityContextExtras = {
        db: driver.scoped(principal.workspace_id),
        // biome-ignore lint/suspicious/noEmptyBlockStatements: deliberate no-op stub; reads don't normally emit outbox events, but read-path extras still expose the method — real implementation lands with the sync-service slice.
        outbox: () => {},
        transact: async () => {
          throw new Error("reads must not call ctx.transact");
        },
      };
      return fn(extras);
    },
    withAuditTx: (fn) => driver.withSystemTx((tx) => fn(asAuditTx(tx))),
  });
}
