/**
 * `AuditWriter` — the interface the dispatcher calls to persist an audit
 * record (architecture.md §6.2, §9.3).
 *
 * The writer is responsible for serializing `AuditRecord` to the
 * `audit_events` schema (§3.11). It is NOT responsible for the write-path
 * DB transaction — on `outcome = "allow"` for a content mutation the
 * dispatcher commits `doc_updates + audit_events + outbox*` in one tx
 * (F31, §6.1). The writer's interface therefore accepts a transaction
 * handle the dispatcher has already begun.
 */

import type { CapabilityId, WorkspaceId } from "@editorzero/ids";
import type { AuditRecord } from "./types";

/**
 * Input to `AuditWriter.write` — the fields the dispatcher knows at
 * record time, derived from the principal + capability + invocation.
 * The persistence layer flattens to `audit_events` columns.
 */
export interface AuditWriteInput {
  readonly workspace_id: WorkspaceId;
  readonly capability_id: CapabilityId;
  readonly principal_kind: "user" | "agent";
  readonly principal_id: string;
  readonly acting_as_user_id: string | null;
  readonly session_id: string | null;
  readonly token_id: string | null;
  readonly subject_kind: string;
  readonly subject_id: string | null;
  readonly input_hash: string;
  readonly duration_ms: number;
  readonly trace_id: string | null;
  readonly record: AuditRecord;
}

/**
 * Tx handle is opaque to audit — the concrete writer implementation knows
 * which driver (SQLite / Postgres) it's bound to.
 */
export type AuditTx = { readonly __brand: "AuditTx" };

export interface AuditWriter {
  /**
   * Writes an audit row inside the provided transaction. Throws on
   * serialization failure; caller rolls back the outer tx.
   */
  write(tx: AuditTx, input: AuditWriteInput): Promise<void>;
}
