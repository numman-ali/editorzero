// biome-ignore-all lint/suspicious/noEmptyBlockStatements: noop logger bodies are intentional
// biome-ignore-all lint/suspicious/noConsole: consoleLogger is the one place console is legitimate (structured dev output)

/**
 * Structured logger contract (architecture.md §16.11).
 *
 * `Logger` is the only logging surface handlers see. The concrete impl
 * (pino + OTel log exporter) lives behind `./sdk` so importing this
 * file with `import type` pulls zero runtime code — the capabilities
 * kernel can depend on the type without pulling OTel into its dep
 * graph.
 *
 * Log events carry a typed `event` key (string-literal union) so Loki /
 * Grafana queries resolve cleanly without pattern-matching strings.
 * Extending the union is additive — every adapter reads `event` as
 * `string` via `LogEvent`.
 */

/**
 * Canonical log-event vocabulary. Add an entry here when you introduce
 * a new structured log call; omit if you're still iterating and plan to
 * drop the call before merging.
 */
export type LogEvent =
  | "dispatcher.invoke"
  | "dispatcher.deny"
  | "dispatcher.error"
  | "write_path.tx_begin"
  | "write_path.tx_commit"
  | "write_path.seq_conflict_retry"
  | "outbox.forwarded"
  | "outbox.leader_acquired"
  | "outbox.leader_lost"
  | "hocuspocus.authenticate"
  | "hocuspocus.store_document"
  | "hocuspocus.change_rejected"
  | "audit.appended"
  | "session.revoke_close"
  | "mirror.projected"
  | "mirror.pushed"
  | "mirror.circuit_broken"
  | "webhook.delivered"
  | "webhook.retry"
  | "webhook.circuit_broken"
  | "job.enqueued"
  | "job.started"
  | "job.completed"
  | "job.failed"
  | "secret.rotated"
  | "reaper.batch_completed"
  | "admin.diagnose_generated";

/**
 * Structured log metadata. Use the `event` key for the log-event
 * vocabulary; every other key is free-form but should follow the
 * `domain.attr` convention (e.g., `doc.id`, `principal.kind`) used by
 * the span attribute helpers in `./attrs`.
 */
export interface LogMeta {
  readonly event?: LogEvent;
  readonly [attr: string]: unknown;
}

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /**
   * Returns a child logger with `meta` merged into every emitted record.
   * Used by the dispatcher to bind `trace_id` / `capability_id` once
   * per invocation so handlers don't repeat attribution on every call.
   */
  child(meta: LogMeta): Logger;
}

// ── Noop / console impls for tests + single-node dev ───────────────────────

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

/**
 * Console-backed logger for local dev. **Not** for production — no
 * structured output, no sampling, no correlation with traces. Production
 * deployments should use the pino + OTel adapter from `./sdk` (to be
 * implemented when the dispatcher lands).
 */
export function consoleLogger(bindings: LogMeta = {}): Logger {
  const emit = (level: string, message: string, meta?: LogMeta): void => {
    const record = { level, message, ...bindings, ...meta };
    console.log(JSON.stringify(record));
  };
  return {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
    child: (meta) => consoleLogger({ ...bindings, ...meta }),
  };
}
