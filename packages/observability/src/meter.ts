// biome-ignore-all lint/suspicious/noEmptyBlockStatements: noop meter bodies are intentional

/**
 * Metric contract (architecture.md §16.11, ADR 0019).
 *
 * Counters, gauges, and histograms are emitted at the same layer
 * boundaries spans are (§16.11). The meter's job is to hand out named
 * instruments bound to the OTel Meter; downstream code uses the
 * instrument interfaces here so the OTel SDK dep stays behind the
 * `./sdk` entrypoint.
 */

export interface Counter {
  add(value: number, attrs?: Record<string, string | number | boolean>): void;
}

/** Monotonic gauge (value set directly, not incremented). */
export interface Gauge {
  set(value: number, attrs?: Record<string, string | number | boolean>): void;
}

/** Histogram — bucketed distribution (latencies, sizes). */
export interface Histogram {
  record(value: number, attrs?: Record<string, string | number | boolean>): void;
}

export interface Meter {
  counter(name: string, description?: string): Counter;
  gauge(name: string, description?: string): Gauge;
  histogram(name: string, description?: string): Histogram;
}

// ── Noop impl ──────────────────────────────────────────────────────────────

const noopCounter: Counter = { add: () => {} };
const noopGauge: Gauge = { set: () => {} };
const noopHistogram: Histogram = { record: () => {} };

export const noopMeter: Meter = {
  counter: () => noopCounter,
  gauge: () => noopGauge,
  histogram: () => noopHistogram,
};
