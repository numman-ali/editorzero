/**
 * Audit types + writer interface (architecture.md §16.3, §9.x).
 *
 * `AuditEffect` is the load-bearing discriminated union for invariant 3a
 * (§9.1): replaying `effect` rows in `created_at` order reproduces
 * `PersistentWorkspaceState` (`./state.ts`) via the reducer (`./reducer.ts`).
 * Every `kind` is classified in `REPLAY_CLASS`; a new variant fails to
 * compile until it is classified (`satisfies`) and, if state-bearing,
 * given a transition. The forcing function is compile-time + the per-kind
 * reducer test — stronger than the once-planned `audit-effect-
 * exhaustiveness` arch-lint (F89).
 *
 * `AuditRecord` is the envelope actually persisted; `outcome ∈ {allow,
 * deny, error}` discriminates whether the `effect` is an `AuditEffect`,
 * `AuditDeny`, or `AuditError` variant (F32 — §9.3).
 */

export type { AclTransition, AclTransitionDroppedGrant, AuditEffect } from "./effect";
export { applyAuditRow, REPLAY_CLASS, type ReplayClass, replay } from "./reducer";
export {
  type AgentState,
  type AgentTokenState,
  type CollectionState,
  type DocState,
  EMPTY_STATE,
  type GrantState,
  type MemberState,
  memberKey,
  type PersistentWorkspaceState,
  type ReplayRow,
  type SpaceMemberState,
  type SpaceState,
  spaceMemberKey,
  type WorkspaceState,
} from "./state";
export type {
  AccessMode,
  AuditDeny,
  AuditError,
  AuditRecord,
  BlockPostState,
  BlockVisibility,
  CollapsePolicy,
  DenyReason,
  DocPurgePreimage,
  HandlerError,
  Role,
  SeedBlock,
} from "./types";
export type { AuditTx, AuditWriteInput, AuditWriter } from "./writer";
