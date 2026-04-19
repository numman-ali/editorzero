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
 * `transact` wired to `HocuspocusSync.bind(ctx)` when `sync` is
 * provided) is a *deployment* decision, not a *dispatcher* decision.
 * So the factory that makes those choices lives where the trunk lives.
 *
 * **Driver parameter is `SqliteDriver` today; widens to `SqliteDriver
 * | PostgresDriver` once Postgres integration lands in a follow-up
 * slice** (ADR 0023). The driver surface (`.withSystemTx`, `.system()`,
 * `.scoped()`) is the same across both; this factory reads only that
 * surface, not SQLite-specific bits, so the widening is mechanical.
 *
 * **`sync` is optional.** When a `HocuspocusSync` is passed, the
 * write-path `ctx.transact` routes through `sync.bind({ sqlTx,
 * principal, workspace_id })` — same pattern proven in
 * `packages/dispatcher/src/writepath.integration.test.ts`. Handler
 * throw triggers `bound.rollback()` so the in-memory Y.Doc is dropped
 * and the next `ctx.transact` re-hydrates from committed
 * `doc_updates` (P3.6e). When `sync` is absent, `ctx.transact` throws
 * a descriptive error — tests and smokes that don't exercise content
 * mutations don't need to boot Hocuspocus.
 *
 * **Read-path `ctx.transact` remains stubbed today.** `doc.get` calls
 * `ctx.transact(doc_id, fn)` in `category: "read"` context to project
 * the block array from the Y.Doc. Wiring `HocuspocusSync` into
 * `runRead` requires an `AuditTx` for the hydration hook
 * (`onLoadDocument` reads `doc_updates` via the sqlTx). Opening a
 * real tx on the read path would acquire the RESERVED lock
 * `runInWriteTx` holds (§6.4), defeating the read/write
 * concurrency story. A tx-less read-path bind variant on
 * `HocuspocusSync` is a separate architectural seam; the
 * `GET /docs/get/:doc_id` route lands with that change. For now,
 * `runRead` preserves the "reads must not call ctx.transact" stub.
 *
 * **`outbox` remains a no-op stub** — the metadata-only mutation
 * atomicity artefact (continuation.md §Immediate focus) lands this
 * together with a capability that emits handler-owned outbox rows.
 * No capability registered today actually emits via `ctx.outbox`;
 * the stub is safe under that precondition.
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
import type { HocuspocusSync } from "@editorzero/sync";

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
  /**
   * Process-scoped Hocuspocus-backed sync. When provided, write-path
   * `ctx.transact` binds against this instance — `doc_updates` +
   * `outbox(doc.updated)` commit inside the dispatcher's SQL tx,
   * handler throw drops the in-memory Y.Doc. When absent, the
   * write-path `ctx.transact` throws a descriptive error so content-
   * mutation capabilities fail loudly (metadata-only capabilities are
   * unaffected — they never call `ctx.transact`).
   *
   * The factory does not own `HocuspocusSync`'s lifecycle. The
   * composition root (production boot script) constructs it once,
   * passes it here, and closes it on shutdown.
   */
  readonly sync?: HocuspocusSync;
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
    sync,
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
        const auditTx = asAuditTx(tx);
        // When `sync` is provided, bind it to the current tx so
        // `ctx.transact` → `DocUpdatesWriter.write(auditTx, …)` commits
        // inside the same `BEGIN IMMEDIATE` region as the handler's
        // `ctx.db` writes and the audit row. Pattern proven in
        // `packages/dispatcher/src/writepath.integration.test.ts`:
        // one `bind` per dispatcher invocation, `bound.rollback()` on
        // handler throw to drop the in-memory Y.Doc so subsequent
        // `ctx.transact` re-hydrates from committed state (P3.6e).
        const bound =
          sync === undefined
            ? undefined
            : sync.bind({
                sqlTx: auditTx,
                principal,
                workspace_id: principal.workspace_id,
              });
        const extras: CapabilityContextExtras = {
          db: createTenantScopedDb(tx, principal.workspace_id),
          // Outbox writes are tx-local in the real (P3.6c) wiring;
          // placeholder here until the metadata-only mutation slice
          // replaces the stub with `ctx.outbox(event)` →
          // `INSERT INTO outbox (..., tx=<current>)`. No capability in
          // the registry today calls `ctx.outbox` from the API trunk,
          // so the stub is safe under that precondition.
          // biome-ignore lint/suspicious/noEmptyBlockStatements: deliberate no-op stub — see comment above.
          outbox: () => {},
          transact:
            bound === undefined
              ? async () => {
                  throw new Error(
                    "createApiDispatcher: ctx.transact is not wired — no `sync` option " +
                      "was passed to createApiDispatcher. Content-mutation capabilities " +
                      "require a HocuspocusSync instance. Metadata-only capabilities do " +
                      "not call transact.",
                  );
                }
              : bound.transact.bind(bound),
        };
        try {
          return await fn(extras, auditTx);
        } catch (err) {
          // The SQL tx is about to roll back. Drop the in-memory Y.Doc
          // for every `doc_id` the handler mutated so the next open
          // re-hydrates from committed `doc_updates`. Closes Codex
          // P3.6c adversarial P2 (durable rollback succeeds but the
          // hot Y.Doc retains the aborted mutation).
          if (bound !== undefined) await bound.rollback();
          throw err;
        }
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
