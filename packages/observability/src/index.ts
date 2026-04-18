/**
 * `@editorzero/observability` — structured logging, tracing, metrics
 * (architecture.md §16.11, ADR 0019).
 *
 * Package shape: types + typed attribute helpers + noop impls. The real
 * OTel SDK bootstrap (pino logger, OTLP exporters) lives behind a
 * separate entrypoint (to be added as `./sdk` when the dispatcher
 * lands). This split keeps dep-light consumers — especially the
 * capabilities kernel — free of the OTel runtime while still using the
 * same type surface the production adapter implements.
 *
 * Usage pattern:
 *   import type { Logger, Tracer } from "@editorzero/observability";
 *     → type-only: zero runtime code imported.
 *   import { noopLogger, noopTracer } from "@editorzero/observability";
 *     → concrete noop impls for tests / startup before SDK init.
 */

export type { SpanAttrs } from "./attrs";
export { attr } from "./attrs";
export type { LogEvent, Logger, LogMeta } from "./logger";
export { consoleLogger, noopLogger } from "./logger";
export type { Counter, Gauge, Histogram, Meter } from "./meter";
export { noopMeter } from "./meter";
export type { Tracer, TracerSpan } from "./tracer";
export { noopTracer } from "./tracer";
