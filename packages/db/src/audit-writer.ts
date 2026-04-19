/**
 * `AuditWriter` over the shared Kysely surface (architecture.md §6.2, §9.3 /
 * ADR 0018 F31). Dialect-agnostic — same factory runs against
 * `createSqliteDriver` and `createPostgresDriver`; empirically verified by
 * `packages/db/test/integration/writers.integration.test.ts`.
 *
 * The opaque `AuditTx` brand produced here is a `Transaction<SystemDatabase>`
 * under the hood. `asAuditTx` casts the live Kysely tx handle to the
 * brand at the producer boundary; `createAuditWriter` casts it
 * back at the consumer boundary. Both casts live inside
 * `@editorzero/db`, so the opaque contract is respected end-to-end —
 * no caller outside this package can produce an `AuditTx` that is not
 * a real Kysely tx. The `no-raw-kysely-outside-db` coherence check
 * keeps raw Kysely imports pinned here, so this is the single
 * sanctioned place the brand gets opened and closed.
 *
 * The writer serialises the `AuditRecord` envelope to the
 * `audit_events` columns field-for-field (§3.11 + F90). `effect` is
 * stored as TEXT-JSON; `deny_reason` is denormalised from
 * `record.effect.reason_code` — the capability-owned public audit
 * contract (AuditDeny, `@editorzero/audit/types.ts:110`). Denormalising
 * from `record.reason.kind` (the internal `DenyReason` taxonomy) would
 * leak implementation detail into the indexed column and let the JSON
 * `effect` payload and the queryable column disagree when a capability
 * maps a reason kind to a custom `reason_code` in `effectOnDeny`.
 */

import type { AuditTx, AuditWriter } from "@editorzero/audit";
import { type AgentId, type TokenId, type UserId, uuidV7 } from "@editorzero/ids";
import type { SubjectKind } from "@editorzero/scopes";
import type { Transaction } from "kysely";

import type { SystemDatabase } from "./schema";

/**
 * Adopt a live `Transaction<SystemDatabase>` as the `AuditTx` the
 * audit writer accepts. The returned handle is the same runtime
 * object — only the static type narrows to the brand.
 */
export function asAuditTx(tx: Transaction<SystemDatabase>): AuditTx {
  return tx as unknown as AuditTx;
}

/**
 * Creation-ordered audit event id. UUIDv7 (architecture.md §3.1) —
 * the time-sorted 48-bit epoch-ms prefix makes `(created_at, id)`
 * pagination deterministic even when multiple rows land in the same
 * millisecond. UUIDv4 would break keyset pagination under burst load.
 */
function nextAuditId(): string {
  return uuidV7();
}

/**
 * **Read-collapse (ADR 0009 / §9.3) — deferred.**
 *
 * This writer always INSERTs with `collapsed_count = 1`; it does not
 * yet inspect the collapse window and fold repeated reads into the
 * prior row. Implementing collapse here is a two-sided change:
 *
 *  - The dispatcher has to resolve `capability.audit.collapsePolicy`
 *    (window_ms + `collapseKey(input)`) and pass the resolved key +
 *    window onto `AuditWriteInput` (which today has neither).
 *  - The writer has to perform a keyed lookup against the prior row
 *    in the window and atomically UPDATE `collapsed_count` instead of
 *    inserting.
 *
 * Landing that under P3.6b would balloon scope past "write-path tx
 * primitive". It is tracked for a follow-up slice. The consequence of
 * deferring: a polling agent that calls `doc.list` every second will
 * produce one `audit_events` row per request instead of one row per
 * window — this is the same behaviour the in-memory test writer has
 * today, so no regression relative to the existing baseline. The
 * fix lands before the runtime composition package wires a live
 * SQLite audit writer behind the public API.
 */
export function createAuditWriter(now: () => number = Date.now): AuditWriter {
  return {
    write: async (tx, input) => {
      const kysely = tx as unknown as Transaction<SystemDatabase>;
      const record = input.record;
      // `effect.reason_code` is the capability-chosen public classification
      // (AuditDeny.reason_code). Keeping the indexed column aligned with
      // the JSON `effect` payload — rather than with the internal
      // `DenyReason.kind` — is what the audit contract promises to
      // downstream analytic queries.
      const deny_reason = record.outcome === "deny" ? record.effect.reason_code : null;
      const effect = JSON.stringify(record.effect);
      const audit_id = nextAuditId();
      const ts = now();
      await kysely
        .insertInto("audit_events")
        .values({
          id: audit_id,
          workspace_id: input.workspace_id,
          capability_id: input.capability_id,
          category: input.category,
          principal_kind: input.principal_kind,
          // The `audit_events` row type is `UserId | AgentId` for the
          // principal columns; `AuditWriteInput` widens to `string` to
          // match the DB column's heterogeneity (F90). The brand is
          // erased at the column boundary — queries that filter by
          // principal must also filter by `principal_kind`, which is
          // why the dispatcher lint rule `no-raw-audit-events-query`
          // pins the query surface.
          principal_id: input.principal_id as UserId | AgentId,
          acting_as_user_id: (input.acting_as_user_id ?? null) as UserId | null,
          session_id: input.session_id,
          token_id: (input.token_id ?? null) as TokenId | null,
          // `AuditWriteInput.subject_kind` is `string` (F90 — rows from
          // different capabilities carry heterogeneous subject kinds
          // and the audit write path does not re-validate). The column
          // is typed `SubjectKind`; the cast is the boundary narrowing.
          subject_kind: input.subject_kind as SubjectKind,
          subject_id: input.subject_id,
          outcome: record.outcome,
          deny_reason,
          input_hash: input.input_hash,
          effect,
          duration_ms: input.duration_ms,
          trace_id: input.trace_id,
          created_at: ts,
          collapsed_count: input.collapsed_count,
        })
        .execute();

      // `outbox(audit.appended)` fan-out (architecture.md §6.2/§6.3).
      // Every `audit_events` INSERT pairs with a transactional-outbox
      // row so downstream webhook, notification, and projection jobs
      // can observe the audit trail at-least-once. Same tx as the
      // audit INSERT: a crash between the two would lose the fan-out
      // and break webhook delivery guarantees. Payload is tight —
      // `audit_id` is the join key; `capability_id` + `outcome` +
      // `category` give the poller enough to compose webhook event
      // keys (`audit.appended.<capability>.<outcome>`, §15.4) without
      // a round-trip re-read of the audit row.
      await kysely
        .insertInto("outbox")
        .values({
          id: uuidV7(),
          workspace_id: input.workspace_id,
          event: "audit.appended",
          payload: JSON.stringify({
            audit_id,
            capability_id: input.capability_id,
            outcome: record.outcome,
            category: input.category,
          }),
          created_at: ts,
          forwarded_at: null,
          forwarded_to: null,
        })
        .execute();
    },
  };
}
