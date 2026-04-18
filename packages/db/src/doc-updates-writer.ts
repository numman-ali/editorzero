/**
 * SQLite-backed `DocUpdatesWriter` (architecture.md §6.1 / ADR 0018 F31).
 *
 * Writes one Y.Doc update — plus its `outbox(doc.updated)` fan-out row —
 * through the dispatcher's write-path tx. The seq is allocated via the
 * `doc_counters` row: INSERT OR IGNORE to bootstrap on first write,
 * SELECT current `next_seq`, UPDATE to `+1`, INSERT `doc_updates` with
 * the allocated value (architecture.md §6.4). All four writes live
 * inside the caller-provided `AuditTx`, so they commit atomically with
 * the rest of the write path — the `docs` INSERT a handler may have
 * just made, the `audit_events` allow row the dispatcher will write
 * after the handler returns, and any other system-level writes in the
 * same tx.
 *
 * Why this lives here and not in `@editorzero/sync`. The
 * `no-raw-kysely-outside-db` coherence check (§8.1a + §17) pins every
 * Kysely import to `packages/db/**`. Sync holds Hocuspocus + Yjs; db
 * holds the SQL. The dispatcher wiring composes them — sync computes
 * the merged update blob from the per-transact Yjs update events, then
 * hands it off to this writer over the `AuditTx` brand.
 *
 * **Tx brand reuse.** We accept `AuditTx` — the brand `@editorzero/audit`
 * defines and `@editorzero/db` narrows back to `Transaction<SystemDatabase>`
 * via `asAuditTx`. Despite the name, the brand is really "a trusted
 * handle to the write-path tx," produced only by `withSystemTx` inside
 * this package. Reusing it means the dispatcher opens one tx and hands
 * the same brand to both the audit writer and the doc-updates writer
 * with no extra cast at the composition boundary. Renaming the brand
 * to `SystemWriteTx` is a separate concern (wider rename, separate commit).
 *
 * **`doc_counters` bootstrap.** The writer auto-bootstraps the counter
 * row via `INSERT INTO doc_counters … ON CONFLICT DO NOTHING` before
 * the SELECT — idempotent across retries, correct for both the
 * first-write case (bootstrap creates the row at seq=1) and the steady-
 * state case (the `ON CONFLICT DO NOTHING` is a no-op). F98's handler-
 * vs-system DB split still holds: handlers can't reach `doc_counters`
 * directly, but the writer is system-package code so the bootstrap
 * here is legal. Auto-bootstrap unblocks `doc.create`'s first-write
 * path without requiring a separate dispatcher priming step — Codex's
 * P3.6c adversarial review flagged the ordering bug: `doc.create` does
 * `ctx.transact` (persist path) before inserting `docs`, so any scheme
 * that primes *after* the handler runs arrives too late. The writer-
 * side INSERT OR IGNORE collapses the bootstrap into the write itself.
 * FK `doc_counters.doc_id REFERENCES docs(id)` still enforces that the
 * `docs` row exists by the time this writer runs — callers must order
 * `docs` INSERT before the first `ctx.transact`.
 *
 * **`outbox(audit.appended)`** is NOT emitted here — that row belongs
 * to the audit write path (architecture.md §6.2), and the dispatcher
 * owns it (P3.6d bundled). This writer's scope is only the two-row
 * mutation-side fan-out: `doc_updates` + `outbox(doc.updated)`.
 */

import type { AuditTx } from "@editorzero/audit";
import { type DocId, uuidV7, type WorkspaceId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import type { Transaction } from "kysely";

import type { SystemDatabase } from "./schema";

export interface DocUpdateWriteInput {
  readonly doc_id: DocId;
  readonly workspace_id: WorkspaceId;
  readonly update_blob: Uint8Array;
  readonly principal: Principal;
}

export interface DocUpdateWriteResult {
  readonly update_id: string;
  readonly seq: number;
}

export interface DocUpdatesWriter {
  write(tx: AuditTx, input: DocUpdateWriteInput): Promise<DocUpdateWriteResult>;
}

export function createSqliteDocUpdatesWriter(now: () => number = Date.now): DocUpdatesWriter {
  return {
    write: async (auditTx, input) => {
      const tx = auditTx as unknown as Transaction<SystemDatabase>;
      const { doc_id, workspace_id, update_blob, principal } = input;
      const ts = now();

      // Bootstrap `doc_counters` if missing. ON CONFLICT DO NOTHING is
      // idempotent and tx-local — if the row already exists (steady
      // state) this is a no-op; if not (first write on a freshly-created
      // doc) this mints it at seq=1. The FK `doc_counters.doc_id
      // REFERENCES docs(id)` surfaces a missing docs row as an SQL FK
      // error, which is what we want — callers must INSERT docs before
      // the first `ctx.transact`.
      await tx
        .insertInto("doc_counters")
        .values({ doc_id, next_seq: 1, updated_at: ts })
        .onConflict((oc) => oc.column("doc_id").doNothing())
        .execute();

      // Seq allocation. Architecture.md §6.4 mandates SELECT + UPDATE on
      // the `doc_counters` row inside the same tx as the `doc_updates`
      // INSERT — gapless on rollback. SQLite's `BEGIN IMMEDIATE` (set
      // by `withSystemTx` via `setIsolationLevel("serializable")`)
      // serialises writers; no `FOR UPDATE` needed.
      const counter = await tx
        .selectFrom("doc_counters")
        .select("next_seq")
        .where("doc_id", "=", doc_id)
        .executeTakeFirstOrThrow();
      const seq = counter.next_seq;
      await tx
        .updateTable("doc_counters")
        .set({ next_seq: seq + 1, updated_at: ts })
        .where("doc_id", "=", doc_id)
        .execute();

      // Every ID is UUIDv7 — time-sortable, the same invariant the
      // audit-writer uses for `audit_events.id` (architecture.md §3.1).
      const update_id = uuidV7();
      await tx
        .insertInto("doc_updates")
        .values({
          id: update_id,
          doc_id,
          workspace_id,
          seq,
          update_blob,
          principal_kind: principal.kind,
          principal_id: principal.id,
          // `session_id` is only populated for human principals with an
          // active session cookie. Agent principals (PATs, agent-auth
          // tokens) carry a `token_id` instead, which lives on
          // `audit_events.token_id` already; replaying back through
          // `doc_updates.session_id` would be nullable-redundant.
          session_id: principal.kind === "user" ? principal.session_id : null,
          created_at: ts,
          delete_after: null,
        })
        .execute();

      // `outbox(doc.updated)` fan-out. Downstream projection /
      // indexing / mirror jobs read this via the poller (§6.3).
      // Payload shape matches the event-dictionary used by the job
      // dispatcher (ADR 0014); expanded payload shapes are
      // downstream-owned — this writer only emits the routing-key
      // fields the poller needs to enqueue work.
      await tx
        .insertInto("outbox")
        .values({
          id: uuidV7(),
          workspace_id,
          event: "doc.updated",
          payload: JSON.stringify({ doc_id, seq, update_id }),
          created_at: ts,
          forwarded_at: null,
          forwarded_to: null,
        })
        .execute();

      return { update_id, seq };
    },
  };
}
