/**
 * Typed error primitives consumed by every layer (architecture.md §16.10).
 *
 * Each subclass owns its structured fields (no shared
 * `Record<string, unknown>` bag) and its own `toHandlerError()` — the
 * projection the dispatcher persists when `outcome = "error"`. The
 * `HandlerError` union lives in `./handler-error` so `audit` imports
 * the shape from here and the projection is not a lossy stringly-typed
 * switch somewhere else.
 *
 * Surfaces map an `EditorZeroError` to HTTP / CLI / MCP / UI
 * representations via a single `mapError(err, surface)` pass; adapters
 * never invent errors, they only map. `code` is the stable identifier
 * surfaces key on; `httpStatus` is the canonical HTTP mapping.
 */

import type {
  BlockId,
  CapabilityId,
  CollectionId,
  DocId,
  SpaceId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import type { SubjectKind } from "@editorzero/scopes";

import type { DenyReason, HandlerError } from "./handler-error";

export type { DenyReason, HandlerError } from "./handler-error";

/**
 * Base class. `toHandlerError` is abstract so adding a new subclass
 * forces a decision about which audit variant it maps to — no central
 * switch that silently defaults to `internal`.
 */
export abstract class EditorZeroError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }

  abstract toHandlerError(): HandlerError;
}

// ── Concrete subclasses ───────────────────────────────────────────────────

/**
 * Input zod validation failed, or a handler detected a domain invariant
 * violation it wants to report as input-shaped. `issues` is `unknown`
 * because zod produces a structured issue list — serializer downstream
 * stringifies it; we don't constrain its shape here (keeps `errors`
 * free of a zod dependency).
 */
export class ValidationError extends EditorZeroError {
  readonly code = "validation_failed";
  readonly httpStatus = 400;
  readonly issues: unknown;

  constructor(params: { message?: string; issues: unknown }) {
    super(params.message ?? "validation failed");
    this.issues = params.issues;
  }

  toHandlerError(): HandlerError {
    return { kind: "validation", issues: this.issues };
  }
}

/**
 * Permission check failed — Layer 1 of the three-layer model (§8.1).
 * Carries the structured `DenyReason` the gate produced so the
 * dispatcher can audit it losslessly.
 */
export class PermissionDeniedError extends EditorZeroError {
  readonly code = "permission_denied";
  readonly httpStatus = 403;
  readonly reason: DenyReason;

  constructor(params: { message?: string; reason: DenyReason }) {
    super(params.message ?? denyMessage(params.reason));
    this.reason = params.reason;
  }

  /**
   * Permission denies are audited as `outcome = "deny"` with an
   * `AuditDeny` effect, not `outcome = "error"`. This projection is
   * provided for the narrow case where a downstream component wants a
   * `HandlerError` shape (e.g., a wrapper that boxed a deny into an
   * error). The canonical path is the dispatcher's deny branch, not
   * this method.
   */
  toHandlerError(): HandlerError {
    return { kind: "internal", trace_id: "" };
  }
}

/** Subject not found in the principal's workspace scope. */
export class NotFoundError extends EditorZeroError {
  readonly code = "not_found";
  readonly httpStatus = 404;
  readonly subject_kind: SubjectKind;
  readonly subject_id: string;

  constructor(params: { message?: string; subject_kind: SubjectKind; subject_id: string }) {
    super(params.message ?? `${params.subject_kind} ${params.subject_id} not found`);
    this.subject_kind = params.subject_kind;
    this.subject_id = params.subject_id;
  }

  toHandlerError(): HandlerError {
    return {
      kind: "not_found",
      subject_kind: this.subject_kind,
      subject_id: this.subject_id,
    };
  }
}

/** Per-principal or per-workspace rate bucket exhausted (§4.1 `rateLimit`). */
export class RateLimitError extends EditorZeroError {
  readonly code = "rate_limited";
  readonly httpStatus = 429;
  readonly bucket: string;
  readonly retry_after_ms: number;

  constructor(params: { message?: string; bucket: string; retry_after_ms: number }) {
    super(params.message ?? `rate limited (${params.bucket})`);
    this.bucket = params.bucket;
    this.retry_after_ms = params.retry_after_ms;
  }

  /**
   * Rate-limit refusals are audited as a `deny` row (reason
   * `rate_limited`), not an `error` row. Same caveat as
   * `PermissionDeniedError.toHandlerError`.
   */
  toHandlerError(): HandlerError {
    return { kind: "internal", trace_id: "" };
  }
}

/**
 * CRDT write conflict, seq-unique retry exhaustion, reconcile stale
 * fetch, concurrent secret rotation (§6.4, §6.6, §16.12).
 * `retry_after_ms` is a client-friendly hint.
 */
export class ConflictError extends EditorZeroError {
  readonly code = "conflict";
  readonly httpStatus = 409;
  readonly retry_after_ms: number | null;

  constructor(params: { message?: string; retry_after_ms?: number | null }) {
    super(params.message ?? "conflict");
    this.retry_after_ms = params.retry_after_ms ?? null;
  }

  toHandlerError(): HandlerError {
    return { kind: "conflict" };
  }
}

/**
 * `doc.update` op carried `expect_prior_content_hash` and the live
 * block's canonical-JSON hash did not match (ADR 0022 §57). The
 * precondition check runs *inside* `ctx.transact` before any op applies;
 * on mismatch the handler throws this error, the transact closure
 * unwinds, and the outer write-path tx rolls back — no partial write
 * lands. Callers re-fetch the block and retry with a fresh hash.
 *
 * Projects to `{ kind: "conflict" }` in audit (shares the handler-error
 * variant with `ConflictError` — the audit layer intentionally folds
 * "optimistic-concurrency rejects" into one kind; surfaces disambiguate
 * on the wire-level `code` (`stale_precondition` vs `conflict`) for
 * retry-policy differentiation. The audit log doesn't need the two
 * flavours distinguished because both are "write was rejected before it
 * landed"; surfaces care because "your fetched state is stale" (hint:
 * re-fetch + retry) differs from "generic concurrent-write lost"
 * (hint: backoff + retry).
 */
export class StalePreconditionError extends EditorZeroError {
  readonly code = "stale_precondition";
  readonly httpStatus = 409;
  readonly block_id: BlockId;
  readonly expected_hash: string;
  readonly actual_hash: string;

  constructor(params: {
    message?: string;
    block_id: BlockId;
    expected_hash: string;
    actual_hash: string;
  }) {
    super(
      params.message ??
        `expect_prior_content_hash mismatch on block ${params.block_id}: ` +
          `expected ${params.expected_hash}, got ${params.actual_hash}`,
    );
    this.block_id = params.block_id;
    this.expected_hash = params.expected_hash;
    this.actual_hash = params.actual_hash;
  }

  toHandlerError(): HandlerError {
    return { kind: "conflict" };
  }
}

/**
 * Caller tried to restore a soft-deleted subject whose parent is itself
 * soft-deleted. Used by `collection.restore` (parent collection) and
 * `doc.restore` (parent collection of a nested doc). Restoring into a
 * trashed parent would leave the subject dangling under deleted scope —
 * the handler refuses and instructs the caller to restore the parent
 * first. Projects to `{ kind: "conflict" }` in audit (shares the fold
 * with `ConflictError` / `StalePreconditionError`); surfaces key on the
 * wire `code` (`parent_deleted`) for targeted client retry copy.
 */
export class ParentDeletedError extends EditorZeroError {
  readonly code = "parent_deleted";
  readonly httpStatus = 409;
  readonly parent_kind: "collection";
  readonly parent_id: CollectionId;

  constructor(params: { message?: string; parent_kind: "collection"; parent_id: CollectionId }) {
    super(
      params.message ??
        `cannot restore: parent ${params.parent_kind} ${params.parent_id} is soft-deleted; restore it first`,
    );
    this.parent_kind = params.parent_kind;
    this.parent_id = params.parent_id;
  }

  toHandlerError(): HandlerError {
    return { kind: "conflict" };
  }
}

/**
 * Caller tried to soft-delete a collection that still has live children
 * (child collections and/or docs with `collection_id` pointing at it).
 * Used by `collection.delete`. ADR 0017's reasoning for soft-delete is
 * recoverable 1:1 state; cascading the delete would make restore
 * impossible without a separate undelete-tree mechanism. Refusing
 * keeps the UX "empty the folder first, then delete it" — the inverse
 * pairs with `collection.restore`'s parent-deleted check. Projects to
 * `{ kind: "conflict" }`.
 *
 * `descendant_counts` is a small bag the client can render without a
 * follow-up list call — "can't delete: 3 docs and 1 subfolder still
 * here" is a better error than a bare 409.
 */
export class HasLiveDescendantsError extends EditorZeroError {
  readonly code = "has_live_descendants";
  readonly httpStatus = 409;
  readonly collection_id: CollectionId;
  readonly descendant_counts: { readonly collections: number; readonly docs: number };

  constructor(params: {
    message?: string;
    collection_id: CollectionId;
    descendant_counts: { readonly collections: number; readonly docs: number };
  }) {
    super(
      params.message ??
        `cannot delete collection ${params.collection_id}: ` +
          `${params.descendant_counts.collections} live child collections + ` +
          `${params.descendant_counts.docs} live docs still here`,
    );
    this.collection_id = params.collection_id;
    this.descendant_counts = params.descendant_counts;
  }

  toHandlerError(): HandlerError {
    return { kind: "conflict" };
  }
}

/**
 * Space-flavored sibling of `HasLiveDescendantsError` (ADR 0040
 * invariant-6 bullet): `space.archive` refuses while the Space still
 * has live collections, live docs (reachable through those
 * collections), or `space_members` rows — the caller empties first, so
 * `space.restore` stays a 1:1 inverse with one audit row each way.
 * Same wire code as the collection refusal (one concept, one
 * vocabulary); the payload is space-shaped, with `members` joining the
 * counts because memberships are space children the collection refusal
 * has no analogue for. Projects to `{ kind: "conflict" }`.
 */
export class SpaceHasLiveDescendantsError extends EditorZeroError {
  readonly code = "has_live_descendants";
  readonly httpStatus = 409;
  readonly space_id: SpaceId;
  readonly descendant_counts: {
    readonly collections: number;
    readonly docs: number;
    readonly members: number;
  };

  constructor(params: {
    message?: string;
    space_id: SpaceId;
    descendant_counts: {
      readonly collections: number;
      readonly docs: number;
      readonly members: number;
    };
  }) {
    super(
      params.message ??
        `cannot archive space ${params.space_id}: ` +
          `${params.descendant_counts.collections} live collections + ` +
          `${params.descendant_counts.docs} live docs + ` +
          `${params.descendant_counts.members} members still here`,
    );
    this.space_id = params.space_id;
    this.descendant_counts = params.descendant_counts;
  }

  toHandlerError(): HandlerError {
    return { kind: "conflict" };
  }
}

/**
 * Sibling-slug uniqueness violation detected by a handler-side pre-check
 * (before the UNIQUE index fires). Used by `collection.create` and
 * `collection.update` so callers get a typed `slug_collision` 409 rather
 * than the raw UNIQUE violation bubbling as an `internal` audit row. The
 * DB-side partial unique index is still the last-line guard on a race
 * (another writer landing between the SELECT and the INSERT/UPDATE);
 * that rare edge still audits as `internal`, but the common path is
 * typed. Projects to `{ kind: "conflict" }`.
 *
 * `parent_kind` distinguishes the two scopes the NULL-aware partial
 * indexes enforce: workspace-root (`parent_id IS NULL`) vs nested under
 * a collection (`parent_id IS NOT NULL`).
 */
export class SlugCollisionError extends EditorZeroError {
  readonly code = "slug_collision";
  readonly httpStatus = 409;
  readonly slug: string;
  readonly parent_kind: "collection" | "workspace";
  readonly parent_id: CollectionId | null;

  constructor(params: {
    message?: string;
    slug: string;
    parent_kind: "collection" | "workspace";
    parent_id: CollectionId | null;
  }) {
    super(
      params.message ??
        `slug "${params.slug}" already taken among siblings under ` +
          `${params.parent_kind} ${params.parent_id ?? "(root)"}`,
    );
    this.slug = params.slug;
    this.parent_kind = params.parent_kind;
    this.parent_id = params.parent_id;
  }

  toHandlerError(): HandlerError {
    return { kind: "conflict" };
  }
}

/**
 * Last-owner protection violation — a role demotion or member removal
 * would leave the workspace with zero `owner` rows. Used by
 * `workspace.member_update_role` and `workspace.member_remove` to
 * surface a typed 409 instead of letting the workspace enter an
 * ownerless state (every destructive workspace-level op would then
 * fail on role gate, including `workspace.member_add` to rescue it).
 *
 * Enforcement inside the write tx, not as an input-validation 400 —
 * a plain pre-check is racy under concurrent admin action (two
 * admins demoting the last two owners in parallel both read
 * `count=2` and both pass). The handler re-reads inside the tx; the
 * 409 is a transactional state conflict.
 *
 * Projects to `{ kind: "conflict" }` in `HandlerError`, matching the
 * shape of `HasLiveDescendantsError` / `SlugCollisionError`.
 */
export class LastOwnerError extends EditorZeroError {
  readonly code = "last_owner_protected";
  readonly httpStatus = 409;
  readonly workspace_id: WorkspaceId;
  readonly user_id: UserId;

  constructor(params: { message?: string; workspace_id: WorkspaceId; user_id: UserId }) {
    super(
      params.message ??
        `cannot demote or remove ${params.user_id}: workspace ${params.workspace_id} would be left with zero owners`,
    );
    this.workspace_id = params.workspace_id;
    this.user_id = params.user_id;
  }

  toHandlerError(): HandlerError {
    return { kind: "conflict" };
  }
}

/**
 * `workspace.member_add` target already has a *live* membership row
 * (i.e. `deleted_at IS NULL`) in the caller's workspace. Distinct from
 * the revive-in-place path (ADR 0024 §5), which handles
 * `deleted_at IS NOT NULL` as an UPDATE and is *not* an error.
 *
 * Separate code from generic `conflict` so callers can distinguish
 * "you tried to add someone who's already a member" (idempotency-adjacent
 * — caller is probably out of sync with the current member list) from
 * "a concurrent write lost the serialization race" (caller should
 * backoff + retry). Same distinction `SlugCollisionError` draws for
 * sibling-slug uniqueness; this class mirrors its shape.
 *
 * Projects to `{ kind: "conflict" }` in `HandlerError` — the audit
 * layer folds "write-refused-by-state" variants into one kind; surfaces
 * disambiguate on the wire `code`.
 */
export class MemberAlreadyExistsError extends EditorZeroError {
  readonly code = "member_already_exists";
  readonly httpStatus = 409;
  readonly workspace_id: WorkspaceId;
  readonly user_id: UserId;

  constructor(params: { message?: string; workspace_id: WorkspaceId; user_id: UserId }) {
    super(
      params.message ??
        `user ${params.user_id} is already a member of workspace ${params.workspace_id}`,
    );
    this.workspace_id = params.workspace_id;
    this.user_id = params.user_id;
  }

  toHandlerError(): HandlerError {
    return { kind: "conflict" };
  }
}

/**
 * Attachment quota exceeded, Yjs update > 256 KB, maintenance_work_mem
 * too small, etc.
 */
export class ResourceLimitError extends EditorZeroError {
  readonly code = "resource_limit";
  readonly httpStatus = 413;
  readonly detail: string;

  constructor(params: { message?: string; detail: string }) {
    super(params.message ?? params.detail);
    this.detail = params.detail;
  }

  toHandlerError(): HandlerError {
    return { kind: "resource_limit", detail: this.detail };
  }
}

/**
 * Downstream service error surfaced through us (storage, email,
 * webhook target). `service` and `status` feed the audit row.
 */
export class UpstreamError extends EditorZeroError {
  readonly code = "upstream_error";
  readonly httpStatus = 502;
  readonly service: string;
  readonly status: number;

  constructor(params: { message?: string; service: string; status: number }) {
    super(params.message ?? `${params.service} returned ${params.status}`);
    this.service = params.service;
    this.status = params.status;
  }

  toHandlerError(): HandlerError {
    return { kind: "upstream", service: this.service, status: this.status };
  }
}

/**
 * Capability handler violated the at-most-once `ctx.transact` contract
 * (§16.4 + ADR 0018, F92). The single-write-path-tx invariant (F31)
 * assumes exactly one CRDT transact per invocation — a second call
 * would split one logical mutation into two `doc_updates` + two
 * `outbox(doc.updated)` rows, so the dispatcher refuses the second
 * call before the Hocuspocus direct-connection tx opens.
 *
 * This is a handler-contract bug, not a domain error — it maps to
 * `internal` in the audit projection. The planned
 * `@editorzero/arch-lint` rule `transact-called-at-most-once` catches
 * this at dev time; until it ships, this runtime backstop is what
 * enforces the invariant.
 */
export class TransactCalledTwiceError extends EditorZeroError {
  readonly code = "transact_called_twice";
  readonly httpStatus = 500;
  readonly capability_id: CapabilityId;
  readonly doc_id: DocId;

  constructor(params: { message?: string; capability_id: CapabilityId; doc_id: DocId }) {
    super(
      params.message ??
        `ctx.transact may be called at most once per invocation; capability ` +
          `${params.capability_id} called it twice on doc ${params.doc_id}`,
    );
    this.capability_id = params.capability_id;
    this.doc_id = params.doc_id;
  }

  toHandlerError(): HandlerError {
    return { kind: "internal", trace_id: "" };
  }
}

/**
 * Unclassified — surfaces an opaque message; full detail lives in logs
 * via `trace_id`. `trace_id` is empty string when the caller has none
 * (pre-instrumentation CLI paths).
 */
export class InternalError extends EditorZeroError {
  readonly code = "internal_error";
  readonly httpStatus = 500;
  readonly trace_id: string;

  constructor(params: { message?: string; trace_id?: string }) {
    super(params.message ?? "internal error");
    this.trace_id = params.trace_id ?? "";
  }

  toHandlerError(): HandlerError {
    return { kind: "internal", trace_id: this.trace_id };
  }
}

/**
 * Project any thrown value to a `HandlerError` variant for the audit
 * writer. Known subclasses delegate to their own `toHandlerError`; an
 * unknown thrown becomes `{ kind: "internal" }` with no `trace_id`.
 *
 * The dispatcher calls this exactly once per error path — there is no
 * other projection site. New subclasses are caught at compile time via
 * the `abstract toHandlerError` contract.
 */
export function toHandlerError(err: unknown): HandlerError {
  if (err instanceof EditorZeroError) return err.toHandlerError();
  return { kind: "internal", trace_id: "" };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function denyMessage(reason: DenyReason): string {
  switch (reason.kind) {
    case "missing_scope":
      return `missing scopes: ${reason.required.join(", ")}`;
    case "cross_workspace":
      return "principal workspace does not match target workspace";
    case "human_only":
      return "capability is human-only; agent denied";
    case "delegator_not_member":
      return "delegated agent's acting_as user holds no active workspace membership";
    case "rate_limited":
      return `rate limited on bucket ${reason.bucket}; retry after ${reason.retry_after_ms}ms`;
    case "acl_deny":
      return "ACL denied";
    case "sub_block_acl_not_implemented":
      return "sub-block ACL selector is reserved; v1 rejects it";
  }
}
