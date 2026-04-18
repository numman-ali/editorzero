/**
 * Audit types + writer interface (architecture.md §16.3, §9.x).
 *
 * `AuditEffect` is the load-bearing discriminated union for invariant 3a
 * (§9.1): replaying `effect` rows in `created_at` order reproduces
 * `PersistentWorkspaceState`. Any new `kind` must add a reducer branch
 * in the replay test; the planned `audit-effect-exhaustiveness`
 * arch-lint rule will backstop it once `@editorzero/arch-lint` ships
 * (F89 — not yet implemented).
 *
 * `AuditRecord` is the envelope actually persisted; `outcome ∈ {allow,
 * deny, error}` discriminates whether the `effect` is an `AuditEffect`,
 * `AuditDeny`, or `AuditError` variant (F32 — §9.3).
 */

export type { AuditEffect } from "./effect";
export type {
  AuditDeny,
  AuditError,
  AuditRecord,
  BlockPostState,
  BlockVisibility,
  CollapsePolicy,
  DenyReason,
  DocPurgePreimage,
  DocVisibility,
  HandlerError,
  Role,
  SeedBlock,
} from "./types";
export type { AuditTx, AuditWriteInput, AuditWriter } from "./writer";
