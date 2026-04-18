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
    case "rate_limited":
      return `rate limited on bucket ${reason.bucket}; retry after ${reason.retry_after_ms}ms`;
    case "acl_deny":
      return "ACL denied";
    case "sub_block_acl_not_implemented":
      return "sub-block ACL selector is reserved; v1 rejects it";
  }
}
