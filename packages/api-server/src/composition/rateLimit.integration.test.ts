/**
 * Real-stack proof of ADR 0044 Decision 6's load-bearing claim: a 429
 * at the door writes NO audit row. The unit suite proves the wrap never
 * calls the inner dispatch when refused; this proves the consequence
 * end-to-end — against a real `createApiDispatcher` + a real SQLite audit
 * table, the `audit_events` count is unchanged across a refusal.
 *
 * This is invariant-3-adjacent: invariant 3 says every MUTATION produces
 * exactly one audit entry; a rate-limit refusal is not a mutation — it
 * mutates nothing and must leave no trace in the log (an audit-row-per-429
 * under flood would aim the flood at the audit table itself).
 */

import { type Capability, createRegistry, registerCapability } from "@editorzero/capabilities";
import { createSqliteDriver, SQLITE_FULL_DDL, type SqliteDriver } from "@editorzero/db";
import { RateLimitError } from "@editorzero/errors";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { AccessPath, UserPrincipal } from "@editorzero/principal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApiDispatcher } from "./createApiDispatcher";
import { createRateLimiter, withRateLimit } from "./rateLimit";

const WORKSPACE_ID = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER_ID = UserId("018f0000-0000-7000-8000-000000000002");
const FIXTURE_ID = CapabilityId("doc.fixture");

let driver: SqliteDriver;

beforeEach(() => {
  driver = createSqliteDriver({ path: ":memory:" });
  driver.exec(SQLITE_FULL_DDL);
});

afterEach(async () => {
  await driver.close();
});

function testUser(): UserPrincipal {
  return {
    kind: "user",
    id: USER_ID,
    workspace_id: WORKSPACE_ID,
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function testAccess(): AccessPath {
  return { workspace_id: WORKSPACE_ID };
}

interface FixtureIO {
  readonly doc_id: string;
}

/**
 * A read capability that writes one allow-audit row per dispatch (the
 * dispatcher's read path), with no DB or sync dependency — exactly enough
 * to count audit rows across the rate gate.
 */
function readFixture(): Capability<FixtureIO, FixtureIO> {
  return {
    id: FIXTURE_ID,
    category: "read",
    summary: "rate-limit integration fixture",
    input: z.object({ doc_id: z.string() }),
    output: z.object({ doc_id: z.string() }),
    requires: ["doc:read"],
    audit: {
      subjectFrom: (input) => ({ kind: "doc", id: input.doc_id }),
      effectOnAllow: () => ({ kind: "audit.access_log" }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: FIXTURE_ID,
        required_scopes: ["doc:read"],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: FIXTURE_ID,
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler: (_ctx, input) => Promise.resolve(input),
  };
}

describe("withRateLimit (real dispatcher + audit table)", () => {
  it("a 429 at the door leaves the audit_events count unchanged", async () => {
    const registry = createRegistry([registerCapability(readFixture())]);
    const dispatcher = createApiDispatcher({ driver, registry, now: () => 1 });
    const BURST = 3;
    // A fixed clock + burst 3 ⇒ exactly 3 admitted, the 4th refused (no
    // refill while the clock stands still).
    const limiter = createRateLimiter({
      now: () => 1,
      userDefault: { per_minute: 60, burst: BURST },
    });
    const wrapped = withRateLimit(dispatcher, limiter);

    const dispatch = () =>
      wrapped.dispatch({
        capability_id: FIXTURE_ID,
        input: { doc_id: "d" },
        principal: testUser(),
        access: testAccess(),
        trace_id: null,
      });

    for (let i = 0; i < BURST; i++) await dispatch();
    const afterAllowed = await driver
      .system()
      .selectFrom("audit_events")
      .select("outcome")
      .execute();
    expect(afterAllowed).toHaveLength(BURST);
    expect(afterAllowed.every((row) => row.outcome === "allow")).toBe(true);

    // The next call is refused BEFORE the dispatcher runs.
    await expect(dispatch()).rejects.toBeInstanceOf(RateLimitError);

    // The refusal wrote nothing — the audit table is byte-for-byte the
    // same set of rows it held before the 429.
    const afterRefused = await driver
      .system()
      .selectFrom("audit_events")
      .select("outcome")
      .execute();
    expect(afterRefused).toHaveLength(BURST);
  });
});
