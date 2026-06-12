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
 * **Driver parameter is structural (`ApiDispatcherDriver`)** — exactly
 * the subset both `SqliteDriver` and `PostgresDriver` share
 * (`.withSystemTx`, `.scoped`), same posture as `LoadRolesDriver` in
 * `@editorzero/db` (ADR 0023). The §8.1a tenant-isolation fuzzer
 * drives this factory against BOTH dialects; production boot still
 * passes the concrete `SqliteDriver`.
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
 * **Read-path `ctx.transact` routes through `HocuspocusSync.read`.**
 * `doc.get` calls `ctx.transact(doc_id, fn)` in `category: "read"`
 * context to project the block array from the Y.Doc. The sync seam's
 * tx-less `read(doc_id, fn)` variant (landed alongside this wiring)
 * opens a DirectConnection with an internal `__read` marker so
 * `onLoadDocument` hydrates via the untransacted reader (no RESERVED
 * lock contention with `runInWriteTx`'s `BEGIN IMMEDIATE`), snapshots
 * the live Y.Doc under the per-doc mutex, and hands `fn` a
 * throwaway clone — handler mutations can't pollute resident state.
 * When `sync` is absent, `runRead.ctx.transact` throws a descriptive
 * error (same posture as the write path). The read surface will
 * formalise as a distinct `ctx.readDoc` in the next slice (kernel
 * split); for now the single `ctx.transact` entry multiplexes on
 * `category`.
 *
 * **`ctx.outbox` is wired transactionally.** Handler-emitted events
 * are queued during `fn(extras, auditTx)` and flushed via
 * `createOutboxWriter().append(auditTx, …)` before the tx commits,
 * inside the same `BEGIN IMMEDIATE` region as the handler's
 * `ctx.db` writes, the `doc_updates` rows (content mutations only),
 * and the dispatcher-written audit row. A handler throw short-
 * circuits the flush and `withSystemTx` rolls back the queued
 * rows with everything else — single-tx atomicity, F10/F31. The
 * read-path variant below throws when a read capability calls
 * `ctx.outbox` (capability bug — reads must not emit).
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
  createOutboxWriter,
  createTenantScopedDb,
  type OutboxAppendInput,
  type OutboxWriter,
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

/**
 * Structural driver surface the factory consumes — the subset
 * `SqliteDriver` and `PostgresDriver` agree on. The factory reads
 * nothing dialect-specific, so either driver slots in (the §8.1a
 * dual-driver fuzzer relies on this; ADR 0023's Postgres boot will).
 */
export type ApiDispatcherDriver = Pick<SqliteDriver, "withSystemTx" | "scoped">;

export interface CreateApiDispatcherOptions {
  readonly driver: ApiDispatcherDriver;
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
  /** Defaults to `createOutboxWriter()` from `@editorzero/db`. */
  readonly outboxWriter?: OutboxWriter;
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
    outboxWriter = createOutboxWriter(),
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
        // Handler-emitted outbox rows are queued here and flushed
        // after the handler returns but before the tx commits (see
        // `try` block below). The kernel signature is synchronous
        // (`outbox(event, payload) => void` in `@editorzero/capabilities`
        // kernel.ts) so the dispatcher can't await the INSERT
        // in-line — queueing keeps the handler surface sync while
        // preserving single-tx atomicity (architecture.md §2101 —
        // "design intent" until this slice). A handler throw short-
        // circuits the flush, and `withSystemTx` rolls back the
        // queued rows with everything else.
        const outboxQueue: OutboxAppendInput[] = [];
        const extras: CapabilityContextExtras = {
          db: createTenantScopedDb(tx, principal.workspace_id),
          outbox: (event, payload) => {
            outboxQueue.push({
              workspace_id: principal.workspace_id,
              event,
              payload,
            });
          },
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
          const result = await fn(extras, auditTx);
          // Flush inside the tx, before return. Actual in-tx order:
          // handler writes → dispatcher's allow-audit writes (invoked
          // inside `fn` via `deps.auditWriter.write(auditTx, …)` —
          // this is what emits `INSERT audit_events` + the paired
          // `INSERT outbox(audit.appended)`) → handler-emitted outbox
          // flush (this loop). The forwarder reads by `outbox.id`
          // (UUIDv7 time-sorted); within-tx ordering between the
          // audit row and the handler-emitted row is not semantically
          // load-bearing — both commit atomically.
          for (const row of outboxQueue) {
            await outboxWriter.append(auditTx, row);
          }
          return result;
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
        // Read capabilities must not emit outbox events — the outbox
        // is for transactional side-effects of mutations (F10/F31).
        // A read calling `ctx.outbox` would either no-op silently
        // (wrong — hides a capability bug) or insert outside any
        // write-path tx (wrong — breaks the single-tx invariant).
        // Throw loud; no capability in the registry today does this.
        outbox: () => {
          throw new Error(
            "createApiDispatcher: ctx.outbox called from a read capability — " +
              "outbox events are only emitted from mutation capabilities " +
              "(architecture.md §6.3, ADR 0018 F10/F31).",
          );
        },
        // Read-path `ctx.transact` routes through `HocuspocusSync.read`
        // — tx-less, no `doc_updates` row, no `__read` marker exposed
        // on the capability surface. The read seam's clone-before-fn
        // shape keeps handler mutations out of the resident Y.Doc,
        // and `#withDocLock` orders this against concurrent
        // `bind().transact` on the same doc. Same "sync optional"
        // posture as the write path: no sync → informative throw.
        transact:
          sync === undefined
            ? async () => {
                throw new Error(
                  "createApiDispatcher: ctx.transact is not wired on the read path — " +
                    "no `sync` option was passed to createApiDispatcher. doc.get and other " +
                    "read capabilities that project Y.Doc state require a HocuspocusSync " +
                    "instance.",
                );
              }
            : sync.read.bind(sync),
      };
      return fn(extras);
    },
    withAuditTx: (fn) => driver.withSystemTx((tx) => fn(asAuditTx(tx))),
  });
}
