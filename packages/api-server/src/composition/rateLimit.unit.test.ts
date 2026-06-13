/**
 * The pre-dispatch rate gate (ADR 0044 Decision 6) — token-bucket
 * semantics, the anti-mint-bypass key, the distinct-by-kind defaults,
 * per-capability buckets, the metered/logged refusal, and the wrap's
 * "refuse at the door → no audit row" contract.
 *
 * The bulk tests drive `createRateLimiter(...).consume(...)` directly
 * over a fake clock — that is where the bucket arithmetic lives. The
 * wrap tests pin the thin translation layer (`withRateLimit`): allow
 * passes through, refuse throws `RateLimitError` WITHOUT calling the
 * inner dispatch (the unit-level proof that a 429 never reaches the
 * audit pipeline; the real-stack proof is `rateLimit.integration.test`).
 */

import {
  type AnyCapability,
  type Capability,
  createRegistry,
  type RateLimit,
  registerCapability,
} from "@editorzero/capabilities";
import type { Dispatcher, DispatcherDeps, DispatchInvocation } from "@editorzero/dispatcher";
import { RateLimitError } from "@editorzero/errors";
import { AgentId, CapabilityId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import { type Logger, type Meter, noopLogger, noopTracer } from "@editorzero/observability";
import type { AccessPath, AgentPrincipal, UserPrincipal } from "@editorzero/principal";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createRateLimiter,
  DEFAULT_AGENT_RATE_LIMIT,
  DEFAULT_USER_RATE_LIMIT,
  withRateLimit,
} from "./rateLimit";

const WORKSPACE_A = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const WORKSPACE_B = WorkspaceId("018f0000-0000-7000-8000-000000000002");
// A user and an agent that share the SAME raw uuid — the kind prefix is
// what keeps their buckets independent after brand erasure.
const SHARED_ID = "018f0000-0000-7000-8000-0000000000aa";
const ALICE = UserId(SHARED_ID);
const AGENT = AgentId(SHARED_ID);
const TOKEN_A = TokenId("018f0000-0000-7000-8000-0000000000c1");
const TOKEN_B = TokenId("018f0000-0000-7000-8000-0000000000c2");
const CAP = CapabilityId("doc.list");

function alice(): UserPrincipal {
  return {
    kind: "user",
    id: ALICE,
    workspace_id: WORKSPACE_A,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

/** An api-key agent; `token` lets two callers share ONE agent id. */
function agent(token = TOKEN_A, workspace = WORKSPACE_A): AgentPrincipal {
  return {
    kind: "agent",
    id: AGENT,
    workspace_id: workspace,
    owner_user_id: ALICE,
    scopes: ["doc:read"],
    token_id: token,
    token_kind: "api-key",
  };
}

/** A clock the tests advance by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

interface MeterAdd {
  readonly name: string;
  readonly value: number;
  // Present (the recorder always captures it) but possibly `undefined` —
  // `Counter.add`'s attrs param is optional, so the recorded value carries
  // that `| undefined` under `exactOptionalPropertyTypes`.
  readonly attrs: Record<string, string | number | boolean> | undefined;
}

/** A meter that records every `counter(...).add(...)`. */
function recordingMeter(): { meter: Meter; adds: MeterAdd[] } {
  const adds: MeterAdd[] = [];
  const meter: Meter = {
    counter: (name) => ({ add: (value, attrs) => adds.push({ name, value, attrs }) }),
    gauge: () => ({ set: () => undefined }),
    histogram: () => ({ record: () => undefined }),
  };
  return { meter, adds };
}

// ── createRateLimiter: token-bucket arithmetic ──────────────────────────────

describe("createRateLimiter — token buckets", () => {
  it("admits up to burst, then refuses with a positive retry hint", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({ now, userDefault: { per_minute: 60, burst: 3 } });
    for (let i = 0; i < 3; i++) {
      expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(true);
    }
    const refused = limiter.consume({ principal: alice(), capability_id: CAP });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.bucket).toBe(`user:${ALICE}`);
    // 60/min ⇒ 1 token/sec ⇒ a full token is 1000ms away.
    expect(refused.retry_after_ms).toBe(1000);
  });

  it("refills lazily as the clock advances — and not a tick early", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      now: clock.now,
      userDefault: { per_minute: 60, burst: 1 },
    });
    expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(true);
    expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(false);
    clock.advance(999); // one millisecond shy of a full token
    expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(false);
    clock.advance(1); // now exactly one token has accrued
    expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(true);
  });

  it("never accrues past burst depth while idle", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({
      now: clock.now,
      userDefault: { per_minute: 60, burst: 2 },
    });
    clock.advance(100_000); // idle far longer than it takes to fill
    expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(true);
    expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(true);
    // Only `burst` (2) were ever available — the third is refused.
    expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(false);
  });
});

// ── Key isolation: the anti-mint-bypass + kind prefix ───────────────────────

describe("createRateLimiter — bucket key is kind:id, never the token", () => {
  it("shares ONE bucket across an agent's tokens (minting more does not buy budget)", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({ now, agentDefault: { per_minute: 60, burst: 2 } });
    // Drain the agent's bucket presenting TOKEN_A.
    expect(limiter.consume({ principal: agent(TOKEN_A), capability_id: CAP }).allowed).toBe(true);
    expect(limiter.consume({ principal: agent(TOKEN_A), capability_id: CAP }).allowed).toBe(true);
    // The SAME agent presenting a DIFFERENT freshly-minted token hits the
    // same `agent:${id}` bucket — still refused. This is the mint-to-bypass
    // lane staying closed (ADR 0044 Decision 6 SHOULD-FIX 2).
    const refused = limiter.consume({ principal: agent(TOKEN_B), capability_id: CAP });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.bucket).toBe(`agent:${AGENT}`);
  });

  it("keeps user and agent buckets independent even when their raw ids collide", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({
      now,
      userDefault: { per_minute: 60, burst: 1 },
      agentDefault: { per_minute: 60, burst: 1 },
    });
    // Drain the AGENT bucket (id == SHARED_ID).
    expect(limiter.consume({ principal: agent(), capability_id: CAP }).allowed).toBe(true);
    expect(limiter.consume({ principal: agent(), capability_id: CAP }).allowed).toBe(false);
    // The USER with the same raw uuid is untouched — the kind prefix split
    // the two id spaces.
    expect(limiter.consume({ principal: alice(), capability_id: CAP }).allowed).toBe(true);
  });
});

// ── Distinct-by-kind defaults (the invariant-8 promise, in numbers) ─────────

describe("createRateLimiter — agents are throttled tighter than users", () => {
  it("exhausts the agent default before the user default under equal load", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({ now }); // production defaults
    let userOk = 0;
    let agentOk = 0;
    for (let i = 0; i < DEFAULT_USER_RATE_LIMIT.burst; i++) {
      if (limiter.consume({ principal: alice(), capability_id: CAP }).allowed) userOk++;
      if (limiter.consume({ principal: agent(), capability_id: CAP }).allowed) agentOk++;
    }
    expect(agentOk).toBe(DEFAULT_AGENT_RATE_LIMIT.burst);
    expect(userOk).toBe(DEFAULT_USER_RATE_LIMIT.burst);
    expect(agentOk).toBeLessThan(userOk);
  });

  it("ships defaults whose agent rate is strictly tighter than the user rate", () => {
    expect(DEFAULT_AGENT_RATE_LIMIT.per_minute).toBeLessThan(DEFAULT_USER_RATE_LIMIT.per_minute);
    expect(DEFAULT_AGENT_RATE_LIMIT.burst).toBeLessThan(DEFAULT_USER_RATE_LIMIT.burst);
  });
});

// ── Per-capability rateLimit metadata (honored where declared) ──────────────

describe("createRateLimiter — per-capability rateLimit is an ADDITIONAL bucket", () => {
  const generousDefault = { per_minute: 6000, burst: 1000 };

  it("a per: global limit is shared across DIFFERENT principals", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({
      now,
      userDefault: generousDefault,
      agentDefault: generousDefault,
    });
    const rl: RateLimit = { per: "global", bucket: "expensive", per_minute: 60, burst: 1 };
    // First caller drains the single global token.
    expect(limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }).allowed).toBe(
      true,
    );
    // A DIFFERENT principal is refused on the same global bucket, though
    // its own principal-default has plenty of budget.
    const refused = limiter.consume({ principal: agent(), capability_id: CAP, rateLimit: rl });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.bucket).toBe("cap:expensive:global");
  });

  it("a per: workspace limit is shared within a workspace, independent across them", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({ now, agentDefault: generousDefault });
    const rl: RateLimit = { per: "workspace", bucket: "ws-cap", per_minute: 60, burst: 1 };
    expect(
      limiter.consume({ principal: agent(TOKEN_A, WORKSPACE_A), capability_id: CAP, rateLimit: rl })
        .allowed,
    ).toBe(true);
    // Same workspace (different token) → refused.
    expect(
      limiter.consume({ principal: agent(TOKEN_B, WORKSPACE_A), capability_id: CAP, rateLimit: rl })
        .allowed,
    ).toBe(false);
    // Different workspace → its own bucket, allowed.
    expect(
      limiter.consume({ principal: agent(TOKEN_A, WORKSPACE_B), capability_id: CAP, rateLimit: rl })
        .allowed,
    ).toBe(true);
  });

  it("defaults can only tighten: an exhausted principal bucket refuses even with per-cap budget", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({ now, userDefault: { per_minute: 60, burst: 1 } });
    const rl: RateLimit = { per: "principal", bucket: "roomy", per_minute: 6000, burst: 1000 };
    expect(limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }).allowed).toBe(
      true,
    );
    const refused = limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    // The principal default is the binding bucket, so it is what is reported.
    expect(refused.bucket).toBe(`user:${ALICE}`);
  });

  it("reports the longest wait when more than one bucket is exhausted", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({ now, userDefault: { per_minute: 60, burst: 1 } }); // 1000ms/token
    const rl: RateLimit = { per: "principal", bucket: "fast", per_minute: 6000, burst: 1 }; // 10ms/token
    expect(limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }).allowed).toBe(
      true,
    );
    const refused = limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    // Both exhausted; the slower-refilling principal default wins the report.
    expect(refused.bucket).toBe(`user:${ALICE}`);
    expect(refused.retry_after_ms).toBe(1000);
  });

  it("reports the per-capability bucket when IT is the slower-refilling one", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({ now, userDefault: { per_minute: 6000, burst: 1 } }); // 10ms/token
    const rl: RateLimit = { per: "global", bucket: "slow", per_minute: 60, burst: 1 }; // 1000ms/token
    expect(limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }).allowed).toBe(
      true,
    );
    const refused = limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl });
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("unreachable");
    expect(refused.bucket).toBe("cap:slow:global");
    expect(refused.retry_after_ms).toBe(1000);
  });

  it("defaults a declared limit's burst to its per_minute when burst is omitted", () => {
    const { now } = fakeClock();
    const limiter = createRateLimiter({ now, userDefault: { per_minute: 6000, burst: 1000 } });
    // No `burst` field → bucket depth falls back to per_minute (2).
    const rl: RateLimit = { per: "global", bucket: "no-burst", per_minute: 2 };
    expect(limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }).allowed).toBe(
      true,
    );
    expect(limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }).allowed).toBe(
      true,
    );
    expect(limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }).allowed).toBe(
      false,
    );
  });

  it("does not charge any bucket when one of several refuses (atomic)", () => {
    const { now } = fakeClock();
    // Default has budget for many; the per-cap global is the bottleneck.
    const limiter = createRateLimiter({ now, userDefault: { per_minute: 6000, burst: 1000 } });
    const rl: RateLimit = { per: "global", bucket: "one-shot", per_minute: 60, burst: 1 };
    limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }); // allowed: charges global AND default (1)
    // Refused on global for 5 straight attempts...
    for (let i = 0; i < 5; i++) {
      expect(
        limiter.consume({ principal: alice(), capability_id: CAP, rateLimit: rl }).allowed,
      ).toBe(false);
    }
    // ...and the principal default was NOT charged for those 5 refusals
    // (atomicity). It started at burst 1000, the one ALLOWED call above
    // charged it once → 999 remain. If the refusals had leaked tokens the
    // count would be 994; observing exactly 999 is the atomic-charge proof.
    let defaultOk = 0;
    for (let i = 0; i < 1000; i++) {
      if (limiter.consume({ principal: alice(), capability_id: CAP }).allowed) defaultOk++;
    }
    expect(defaultOk).toBe(999);
  });
});

// ── Metering + structured logging on refusal ────────────────────────────────

describe("createRateLimiter — a refusal is metered and logged (never silent)", () => {
  it("meters the refusal per bucket with capability + kind + token labels", () => {
    const { now } = fakeClock();
    const { meter, adds } = recordingMeter();
    const limiter = createRateLimiter({ now, meter, agentDefault: { per_minute: 60, burst: 1 } });
    limiter.consume({ principal: agent(), capability_id: CAP }); // allowed
    limiter.consume({ principal: agent(), capability_id: CAP }); // refused
    expect(adds).toHaveLength(1);
    expect(adds[0]).toEqual({
      name: "ratelimit.refused",
      value: 1,
      attrs: {
        "ratelimit.bucket": `agent:${AGENT}`,
        "capability.id": CAP,
        "principal.kind": "agent",
        "token.id": TOKEN_A, // a LABEL only — never part of the bucket key
      },
    });
  });

  it("logs the tuple key + capability id + retry hint as a structured warn", () => {
    const { now } = fakeClock();
    const warn = vi.fn();
    const logger: Logger = { ...noopLogger, warn };
    const limiter = createRateLimiter({ now, logger, userDefault: { per_minute: 60, burst: 1 } });
    limiter.consume({ principal: alice(), capability_id: CAP });
    limiter.consume({ principal: alice(), capability_id: CAP });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("rate limit exceeded"),
      expect.objectContaining({
        event: "ratelimit.refused",
        "ratelimit.bucket": `user:${ALICE}`,
        "ratelimit.retry_after_ms": 1000,
        "capability.id": CAP,
        "principal.kind": "user",
      }),
    );
  });

  it("omits the token label for a human (no token_id)", () => {
    const { now } = fakeClock();
    const { meter, adds } = recordingMeter();
    const limiter = createRateLimiter({ now, meter, userDefault: { per_minute: 60, burst: 1 } });
    limiter.consume({ principal: alice(), capability_id: CAP });
    limiter.consume({ principal: alice(), capability_id: CAP });
    expect(adds[0]?.attrs).not.toHaveProperty("token.id");
  });
});

// ── withRateLimit wrap: allow passes through, refuse never dispatches ────────

interface FixtureIO {
  readonly doc_id: string;
}

function buildFixture(rateLimit?: RateLimit): Capability<FixtureIO, FixtureIO> {
  return {
    id: CAP,
    category: "read",
    summary: "rate-limit wrap fixture",
    input: z.object({ doc_id: z.string() }),
    output: z.object({ doc_id: z.string() }),
    requires: ["doc:read"],
    ...(rateLimit !== undefined && { rateLimit }),
    audit: {
      subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
      effectOnAllow: () => ({ kind: "audit.access_log" }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: CAP,
        required_scopes: ["doc:read"],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: CAP,
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler: (_ctx, input) => Promise.resolve(input),
  };
}

/**
 * A `Dispatcher` whose only real part is `deps.registry` (the wrap reads
 * the capability's `rateLimit` from it). The remaining `deps` IO is never
 * reached in a wrap test — allow calls the `dispatch` spy, refuse never
 * dispatches — so those fields throw if touched.
 */
function fakeDispatcher(
  caps: readonly AnyCapability[],
  dispatch: (invocation: DispatchInvocation) => Promise<unknown>,
): Dispatcher {
  const unused = (): never => {
    throw new Error("wrap test reached inner dispatcher IO it should not");
  };
  const deps: DispatcherDeps = {
    registry: createRegistry(caps),
    gate: { check: unused },
    auditWriter: { write: unused },
    tracer: noopTracer,
    logger: noopLogger,
    now: () => 0,
    runInWriteTx: unused,
    runRead: unused,
    withAuditTx: unused,
  };
  return { dispatch, deps };
}

function invocation(): DispatchInvocation {
  const access: AccessPath = { workspace_id: WORKSPACE_A };
  return { capability_id: CAP, input: { doc_id: "d" }, principal: alice(), access, trace_id: null };
}

describe("withRateLimit — the wrap", () => {
  it("passes an admitted invocation through to the inner dispatch", async () => {
    const dispatch = vi.fn(() => Promise.resolve({ doc_id: "d" }));
    const wrapped = withRateLimit(
      fakeDispatcher([registerCapability(buildFixture())], dispatch),
      createRateLimiter(),
    );
    await expect(wrapped.dispatch(invocation())).resolves.toEqual({ doc_id: "d" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("throws RateLimitError and NEVER calls the inner dispatch when refused (no audit row)", async () => {
    const dispatch = vi.fn(() => Promise.resolve({ doc_id: "d" }));
    const limiter = createRateLimiter({ userDefault: { per_minute: 60, burst: 1 } });
    const wrapped = withRateLimit(
      fakeDispatcher([registerCapability(buildFixture())], dispatch),
      limiter,
    );
    await wrapped.dispatch(invocation()); // drains the single token
    await expect(wrapped.dispatch(invocation())).rejects.toBeInstanceOf(RateLimitError);
    // The refusal short-circuited BEFORE the dispatcher ran — nothing
    // entered the audit pipeline, so no audit row could be written.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("surfaces the capability's declared rateLimit as the binding bucket", async () => {
    const dispatch = vi.fn(() => Promise.resolve({ doc_id: "d" }));
    const rl: RateLimit = { per: "global", bucket: "wrap-cap", per_minute: 60, burst: 1 };
    // Generous principal default so the per-capability bucket is the limit.
    const limiter = createRateLimiter({ userDefault: { per_minute: 6000, burst: 1000 } });
    const wrapped = withRateLimit(
      fakeDispatcher([registerCapability(buildFixture(rl))], dispatch),
      limiter,
    );
    await wrapped.dispatch(invocation());
    await expect(wrapped.dispatch(invocation())).rejects.toMatchObject({
      bucket: "cap:wrap-cap:global",
    });
  });

  it("still charges the principal bucket for an unknown capability, then lets it fall through", async () => {
    // Empty registry → lookup() is undefined → no per-cap bucket, but the
    // principal default IS charged; the inner dispatch decides the
    // unknown-capability outcome (here the spy stands in for it).
    const dispatch = vi.fn(() => Promise.resolve({ ok: true }));
    const wrapped = withRateLimit(fakeDispatcher([], dispatch), createRateLimiter());
    await expect(wrapped.dispatch(invocation())).resolves.toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("passes the inner dispatcher's deps through unchanged", () => {
    const inner = fakeDispatcher([registerCapability(buildFixture())], () => Promise.resolve({}));
    const wrapped = withRateLimit(inner, createRateLimiter());
    expect(wrapped.deps).toBe(inner.deps);
  });
});
