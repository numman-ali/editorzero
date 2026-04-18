// biome-ignore-all lint/suspicious/noEmptyBlockStatements: noop span methods are intentional

/**
 * Tracer contract (architecture.md §16.11).
 *
 * Spans are emitted at **layer boundaries**, not per function (§16.11).
 * The dispatcher wraps each capability invocation in a span; the repo
 * layer wraps each query; mirror jobs, Hocuspocus handlers, MCP
 * sessions all emit canonical spans from their shared adapter.
 */

/**
 * A live span. Handlers inside `Tracer.span(name, fn)` receive one and
 * may call `setAttribute` or `addEvent` to enrich it. The caller does
 * not call `end()` — the tracer ends the span when `fn` resolves or
 * throws (the outer adapter is responsible).
 */
export interface TracerSpan {
  /**
   * Record a typed attribute. Prefer helpers in `./attrs` (e.g.,
   * `attr.principal(p)`) over raw string keys to avoid sprawl.
   */
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attrs: Record<string, string | number | boolean>): void;
  /** Add a time-stamped event to the current span. */
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): void;
  /** Mark the span as errored; typically called by the adapter on throw. */
  recordError(err: unknown): void;
}

/**
 * Tracer. `span(name, fn)` is the only shape handlers use — it starts a
 * span, runs `fn` inside its context, and ends the span automatically.
 * Exceptions propagate; the span is marked errored before the throw.
 */
export interface Tracer {
  span<T>(name: string, fn: (span: TracerSpan) => T | Promise<T>): Promise<T>;
}

// ── Noop impl for tests + places tracing hasn't been wired yet ────────────

const noopSpan: TracerSpan = {
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  recordError: () => {},
};

export const noopTracer: Tracer = {
  span: async (_name, fn) => fn(noopSpan),
};
