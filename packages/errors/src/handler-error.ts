/**
 * `HandlerError` and `DenyReason` — the tagged unions the audit writer
 * persists for `outcome ∈ {deny, error}` rows (architecture.md §9.3).
 *
 * Living in `@editorzero/errors` (not `audit`) because they are the
 * *shape* an `EditorZeroError` subclass projects to when it is audited.
 * Each subclass owns its own `toHandlerError()` — the union below is
 * the closed set of projections the dispatcher can ever see. Adding a
 * new error subclass requires either picking one of these variants or
 * widening the union here first; TS catches the missing mapping either
 * way. The audit package re-exports both types for back-compat so
 * downstream consumers only need one import.
 */

import type { CollectionId, DocId } from "@editorzero/ids";
import type { Scope, SubjectKind } from "@editorzero/scopes";

export type DenyReason =
  | { kind: "missing_scope"; required: readonly Scope[]; principal_scopes: readonly Scope[] }
  | { kind: "cross_workspace" }
  | { kind: "human_only" }
  | { kind: "rate_limited"; bucket: string; retry_after_ms: number }
  | {
      kind: "acl_deny";
      scope: { readonly doc_id: DocId } | { readonly collection_id: CollectionId };
    }
  | { kind: "sub_block_acl_not_implemented" };

export type HandlerError =
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found"; subject_kind: SubjectKind; subject_id: string }
  | { kind: "conflict" }
  | { kind: "resource_limit"; detail: string }
  | { kind: "upstream"; service: string; status: number }
  | { kind: "internal"; trace_id: string };
