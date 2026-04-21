/**
 * `OutboxWriter` — handler-facing side of the transactional-outbox
 * pattern (architecture.md §6.3 + ADR 0018 F10/F31).
 *
 * `createAuditWriter` and `createDocUpdatesWriter` emit their own
 * outbox rows inline (`audit.appended` and `doc.updated` respectively);
 * this writer exists for the third emission path — events that capability
 * handlers raise via `ctx.outbox(event, payload)`. The dispatcher
 * composition (`packages/api-server/src/composition/createApiDispatcher`)
 * wires the handler's calls to this writer inside the write-path tx
 * so the outbox row commits in the same `BEGIN IMMEDIATE` region as
 * the handler's `ctx.db` writes and the audit row.
 *
 * Dialect-agnostic — same factory runs against `createSqliteDriver`
 * and `createPostgresDriver`; conformance coverage rides the same
 * harness as the two existing writers (`test/integration/writers.
 * integration.test.ts`).
 *
 * **`workspace_id` is always non-null here.** The outbox table allows
 * `workspace_id = NULL` for system-level events emitted by
 * non-handler code (the poller itself, migration jobs, cluster-scope
 * events — §3.11). Handler-emitted rows always carry a workspace:
 * the dispatcher passes `principal.workspace_id` at the composition
 * boundary, and there is no legitimate path for a handler to emit a
 * workspace-less event. The type narrows the input accordingly.
 *
 * **Payload is serialized here.** The kernel signature takes
 * `payload: unknown`; this writer JSON-stringifies at the table
 * boundary so handlers keep a structural object API and the forwarder
 * reads a stable `TEXT` column. Non-serialisable payloads (functions,
 * cycles, `BigInt`) surface as `TypeError` from `JSON.stringify` —
 * that's a handler bug and it aborts the write-path tx, which is the
 * right posture: a corrupt outbox row is worse than a rolled-back
 * mutation.
 */

import type { AuditTx } from "@editorzero/audit";
import { uuidV7, type WorkspaceId } from "@editorzero/ids";
import type { Transaction } from "kysely";

import type { SystemDatabase } from "./schema";

export interface OutboxAppendInput {
  readonly workspace_id: WorkspaceId;
  readonly event: string;
  readonly payload: unknown;
}

export interface OutboxWriter {
  append(tx: AuditTx, input: OutboxAppendInput): Promise<void>;
}

export function createOutboxWriter(now: () => number = Date.now): OutboxWriter {
  return {
    append: async (auditTx, input) => {
      const tx = auditTx as unknown as Transaction<SystemDatabase>;
      await tx
        .insertInto("outbox")
        .values({
          id: uuidV7(),
          workspace_id: input.workspace_id,
          event: input.event,
          payload: JSON.stringify(input.payload),
          created_at: now(),
          forwarded_at: null,
          forwarded_to: null,
        })
        .execute();
    },
  };
}
