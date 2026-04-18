/**
 * Typed error primitives consumed by every layer (architecture.md §16.10).
 *
 * Handlers throw `EditorZeroError` subclasses; each surface adapter has a
 * single `mapError(err, surface)` pass that converts to HTTP status +
 * RFC 9457 problem body (API), CLI exit code + stderr message, MCP
 * protocol error, or UI `ActionResult`. **Adapters never invent errors;
 * they only map** — keeping the error shape the one place it lives.
 *
 * `code` is the stable identifier surfaces key on; `httpStatus` is the
 * canonical mapping for the HTTP surface (other surfaces derive their own
 * from `code`). `fields` carries structured context that a `problem+json`
 * body / CLI `--json` output can render without string-parsing a message.
 */

export abstract class EditorZeroError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly fields?: Record<string, unknown>;

  constructor(message: string, fields?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    if (fields !== undefined) this.fields = fields;
  }
}

/** Permission check failed — Layer 1 of the three-layer model (§8.1). */
export class PermissionDeniedError extends EditorZeroError {
  readonly code = "permission_denied";
  readonly httpStatus = 403;
}

/** Input zod validation failed, or domain-level invariant violation. */
export class ValidationError extends EditorZeroError {
  readonly code = "validation_failed";
  readonly httpStatus = 400;
}

/** Subject not found in the principal's workspace scope. */
export class NotFoundError extends EditorZeroError {
  readonly code = "not_found";
  readonly httpStatus = 404;
}

/** Per-principal or per-workspace rate bucket exhausted (§4.1 `rateLimit`). */
export class RateLimitError extends EditorZeroError {
  readonly code = "rate_limited";
  readonly httpStatus = 429;
}

/**
 * CRDT write conflict, seq-unique retry exhaustion, reconcile stale fetch,
 * concurrent secret rotation (§6.4, §6.6, §16.12). The `fields` carry
 * `retry_after_ms` for client-friendly retry hints.
 */
export class ConflictError extends EditorZeroError {
  readonly code = "conflict";
  readonly httpStatus = 409;
}

/** Attachment quota exceeded, Yjs update > 256 KB, maintenance_work_mem too small, etc. */
export class ResourceLimitError extends EditorZeroError {
  readonly code = "resource_limit";
  readonly httpStatus = 413;
}

/** Downstream service error surfaced through us (storage, email, webhook target). */
export class UpstreamError extends EditorZeroError {
  readonly code = "upstream_error";
  readonly httpStatus = 502;
}

/** Unclassified — surfaces an opaque message; full detail lives in logs via `trace_id`. */
export class InternalError extends EditorZeroError {
  readonly code = "internal_error";
  readonly httpStatus = 500;
}
