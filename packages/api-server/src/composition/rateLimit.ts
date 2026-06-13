/**
 * `withRateLimit` — the dispatcher's pre-dispatch rate gate (ADR 0044
 * Decision 6, the dangling invariant-8 leg).
 *
 * Invariant 8 promises agents DISTINCT rate limits from humans. This is
 * the thin, honest, single-process realization: a `withRateLimit` wrap
 * (the `withRevocationTap` composition pattern) holding in-memory token
 * buckets, with defaults that throttle agents tighter than users, and
 * per-capability `rateLimit` metadata honored where a capability declares
 * it. The wrap sits OUTERMOST around the dispatcher — the refusal happens
 * at the door, before the gate, the handler, and the audit pipeline.
 *
 * Two SHOULD-FIX decisions from the cross-model round are baked in:
 *
 *   1. **The principal bucket key is the tuple `${kind}:${id}`** —
 *      kind-prefixed so the user and agent id spaces can never collide
 *      after brand erasure (both are bare UUID strings underneath).
 *      `token_id` is a metric/log LABEL only, NEVER part of the key: a
 *      per-token bucket would let one agent multiply its budget by
 *      minting many tokens — the exact mint-to-bypass lane the credential
 *      model otherwise closes.
 *   2. **A 429 is a structured-logged, metered refusal — NOT an audit
 *      row.** The refusal happens BEFORE the inner dispatch, so it never
 *      reaches the dispatcher's audit pipeline: it mutates nothing
 *      (invariant 3 governs mutations) and an audit-row-per-429 under
 *      flood would aim the flood at the audit table itself (the self-DoS
 *      shape ADR 0009's audit-rate-limit note guards against). Not
 *      silent: the typed `RateLimitError` reaches the caller as a 429
 *      (api-server) / `rate_limited` (MCP), an OTel counter meters per
 *      bucket, and the structured warn carries the tuple key + capability
 *      id.
 *
 * Single-process is honest — the deployment is one trunk process (ADR
 * 0027). A multi-process deployment needs a shared bucket store; THIS
 * wrap is the documented insertion point (ADR 0044 revisit trigger) —
 * swap the in-memory `Map` for a shared backend behind the same
 * `RateLimiter` interface and nothing upstream changes.
 */

import type { RateLimit } from "@editorzero/capabilities";
import type { Dispatcher } from "@editorzero/dispatcher";
import { RateLimitError } from "@editorzero/errors";
import type { CapabilityId } from "@editorzero/ids";
import { type Logger, type Meter, noopLogger, noopMeter } from "@editorzero/observability";
import type { Principal } from "@editorzero/principal";

/** A resolved bucket rate: sustained refill + the burst depth. */
export interface RateLimitSpec {
  /** Sustained refill rate, tokens per minute. */
  readonly per_minute: number;
  /** Bucket depth — the largest instantaneous burst before throttling. */
  readonly burst: number;
}

/**
 * Per-principal-kind defaults — the invariant-8 "distinct limits" in
 * concrete numbers. Agents are throttled tighter than humans: a human
 * drives one interactive session that legitimately bursts (open a doc,
 * fan out a handful of reads); an agent is automation whose steady state
 * should be bounded well below a human's reflexes.
 *
 * These are POLICY numbers, co-located with the enforcement that is their
 * only consumer (no other surface reads them, so a `packages/constants`
 * home would be coupling without a second reader). They are
 * `createRateLimiter` options so a deployment can tune them without
 * forking the wrap.
 */
export const DEFAULT_USER_RATE_LIMIT: RateLimitSpec = { per_minute: 600, burst: 120 };
export const DEFAULT_AGENT_RATE_LIMIT: RateLimitSpec = { per_minute: 120, burst: 30 };

/** What the wrap asks the limiter to charge for one dispatch. */
export interface RateLimitRequest {
  readonly principal: Principal;
  readonly capability_id: CapabilityId;
  /** The capability's declared limit, if any (an additional bucket). */
  readonly rateLimit?: RateLimit;
}

/** Allow → charge succeeded. Refuse → the worst exhausted bucket + wait. */
export type RateLimitOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly bucket: string; readonly retry_after_ms: number };

export interface RateLimiter {
  /**
   * Charge one unit against every bucket this request must pass (the
   * principal-kind default, plus the capability's declared bucket when
   * present). Atomic: if ANY bucket is exhausted, NONE is charged and the
   * outcome reports the longest wait. Metering + the structured warn fire
   * here on refusal — the wrap only translates the outcome to a throw.
   */
  readonly consume: (req: RateLimitRequest) => RateLimitOutcome;
}

export interface CreateRateLimiterOptions {
  /** Defaults to `Date.now`. Tests override for a deterministic clock. */
  readonly now?: () => number;
  /** Structured logger for refusals. Defaults to `noopLogger`. */
  readonly logger?: Logger;
  /** Meter for the per-bucket refusal counter. Defaults to `noopMeter`. */
  readonly meter?: Meter;
  /** Per-principal default rate. Defaults to {@link DEFAULT_USER_RATE_LIMIT}. */
  readonly userDefault?: RateLimitSpec;
  /** Per-agent default rate. Defaults to {@link DEFAULT_AGENT_RATE_LIMIT}. */
  readonly agentDefault?: RateLimitSpec;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/** A capability `RateLimit` resolved to a {@link RateLimitSpec}. */
function specOf(rateLimit: RateLimit): RateLimitSpec {
  return { per_minute: rateLimit.per_minute, burst: rateLimit.burst ?? rateLimit.per_minute };
}

/**
 * The bucket key for a capability-declared `rateLimit`, by its `per`
 * scope. The `principal` scope stays kind-prefixed for the SAME
 * anti-bypass reason as the default bucket (token_id is never in it).
 */
function capBucketKey(rateLimit: RateLimit, principal: Principal): string {
  // Exhaustive over the closed `per` union — adding a 4th value makes
  // this fail `noImplicitReturns` until it gets a case (no runtime guard
  // needed, and none that coverage would mark dead).
  switch (rateLimit.per) {
    case "principal":
      return `cap:${rateLimit.bucket}:${principal.kind}:${principal.id}`;
    case "workspace":
      return `cap:${rateLimit.bucket}:ws:${principal.workspace_id}`;
    case "global":
      return `cap:${rateLimit.bucket}:global`;
  }
}

/**
 * Refill a bucket to `nowMs` (lazily — buckets only advance when touched)
 * and return its live state. A fresh bucket starts FULL so the first
 * burst is admitted. Refilling never consumes, so calling this on a
 * refused request is safe: it only accrues tokens for elapsed time.
 */
function refillBucket(
  buckets: Map<string, BucketState>,
  key: string,
  spec: RateLimitSpec,
  nowMs: number,
): BucketState {
  const existing = buckets.get(key);
  if (existing === undefined) {
    const fresh: BucketState = { tokens: spec.burst, lastRefillMs: nowMs };
    buckets.set(key, fresh);
    return fresh;
  }
  const elapsed = Math.max(0, nowMs - existing.lastRefillMs);
  existing.tokens = Math.min(spec.burst, existing.tokens + elapsed * (spec.per_minute / 60_000));
  existing.lastRefillMs = nowMs;
  return existing;
}

/**
 * Observability labels for a refusal. `token.id` is a LABEL only — never
 * the bucket key (ADR 0044 Decision 6 anti-mint-bypass) — so operators
 * can see WHICH token a flooding agent presented without giving each
 * token its own budget.
 */
function refusalLabels(req: RateLimitRequest): Record<string, string> {
  const labels: Record<string, string> = {
    "capability.id": req.capability_id,
    "principal.kind": req.principal.kind,
  };
  if (req.principal.token_id !== null) labels["token.id"] = req.principal.token_id;
  return labels;
}

export function createRateLimiter(options: CreateRateLimiterOptions = {}): RateLimiter {
  const {
    now = () => Date.now(),
    logger = noopLogger,
    meter = noopMeter,
    userDefault = DEFAULT_USER_RATE_LIMIT,
    agentDefault = DEFAULT_AGENT_RATE_LIMIT,
  } = options;
  const buckets = new Map<string, BucketState>();
  const refusals = meter.counter(
    "ratelimit.refused",
    "Dispatch invocations refused by the rate limiter, by bucket",
  );

  const consume = (req: RateLimitRequest): RateLimitOutcome => {
    const nowMs = now();
    // The principal-kind default bucket — the live invariant-8 limit.
    // Key is the `${kind}:${id}` tuple; never the token_id.
    const checks: { readonly key: string; readonly spec: RateLimitSpec }[] = [
      {
        key: `${req.principal.kind}:${req.principal.id}`,
        spec: req.principal.kind === "agent" ? agentDefault : userDefault,
      },
    ];
    // A capability-declared limit is an ADDITIONAL bucket the request must
    // also pass — defaults always apply; metadata can only tighten.
    if (req.rateLimit !== undefined) {
      checks.push({ key: capBucketKey(req.rateLimit, req.principal), spec: specOf(req.rateLimit) });
    }

    // Refill every bucket, then charge iff ALL pass — a refusal on one
    // bucket must not leak a token from another (atomic charge).
    const refused: { key: string; retry_after_ms: number }[] = [];
    const states = checks.map(({ key, spec }) => {
      const state = refillBucket(buckets, key, spec, nowMs);
      if (state.tokens < 1) {
        refused.push({
          key,
          retry_after_ms: Math.ceil((1 - state.tokens) / (spec.per_minute / 60_000)),
        });
      }
      return state;
    });

    if (refused.length === 0) {
      for (const state of states) state.tokens -= 1;
      return { allowed: true };
    }

    // Refuse with the longest wait among the exhausted buckets; charge
    // nothing. Meter + warn here — the wrap only turns this into a throw.
    const worst = refused.reduce((a, b) => (b.retry_after_ms > a.retry_after_ms ? b : a));
    const labels = refusalLabels(req);
    refusals.add(1, { "ratelimit.bucket": worst.key, ...labels });
    logger.warn("rate limit exceeded — refused at the door (no audit row)", {
      event: "ratelimit.refused",
      "ratelimit.bucket": worst.key,
      "ratelimit.retry_after_ms": worst.retry_after_ms,
      ...labels,
    });
    return { allowed: false, bucket: worst.key, retry_after_ms: worst.retry_after_ms };
  };

  return { consume };
}

/**
 * Wrap a dispatcher so every invocation is charged against the limiter
 * BEFORE it reaches the inner dispatch. An exhausted bucket throws
 * `RateLimitError` (→ 429 / `rate_limited`) here — pre-gate, pre-handler,
 * pre-audit — so the refusal mutates nothing and writes no audit row
 * (ADR 0044 Decision 6). On allow, the invocation flows through
 * untouched. `deps` is passed through so the wrap is transparent to every
 * other consumer (the collab write lane, `createApiApp`).
 *
 * An unknown `capability_id` still charges the PRINCIPAL-DEFAULT bucket
 * (so a bogus-id flood is throttled like any other), but gets no
 * per-capability bucket — the non-throwing `registry.lookup` returns
 * `undefined`, so there is no `rateLimit` metadata to read. The
 * unknown-capability error itself is not pre-empted: when the principal
 * bucket has budget the invocation flows through to the inner dispatch,
 * which raises the canonical `RegistryLookupError`.
 */
export function withRateLimit(dispatcher: Dispatcher, limiter: RateLimiter): Dispatcher {
  return {
    dispatch: async (invocation) => {
      const capability = dispatcher.deps.registry.lookup(invocation.capability_id);
      const outcome = limiter.consume({
        principal: invocation.principal,
        capability_id: invocation.capability_id,
        ...(capability?.rateLimit !== undefined && { rateLimit: capability.rateLimit }),
      });
      if (!outcome.allowed) {
        throw new RateLimitError({
          bucket: outcome.bucket,
          retry_after_ms: outcome.retry_after_ms,
        });
      }
      return dispatcher.dispatch(invocation);
    },
    deps: dispatcher.deps,
  };
}
