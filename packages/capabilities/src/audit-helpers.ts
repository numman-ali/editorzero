/**
 * Small projections shared across capability audit declarations.
 *
 * `projectErrorAudit` maps a `HandlerError` to the `AuditError`
 * envelope the dispatcher persists on `outcome = "error"`. The
 * canonical flow is: capability handler throws `ValidationError` /
 * `NotFoundError` / `ConflictError` / etc. → dispatcher calls
 * `err.toHandlerError()` → dispatcher hands the resulting
 * `HandlerError` to `capability.audit.effectOnError`. This helper
 * centralises the projection so:
 *
 *   1. `error_code` on the audit row mirrors the thrown kind
 *      (`"validation"` / `"conflict"` / `"upstream"` / …) instead
 *      of flattening everything to `"internal"`. That keeps the
 *      audit log usefully partitioned by failure shape (invariant
 *      3a — `audit.error` rows are analytic inputs, not just
 *      breadcrumbs).
 *   2. `retriable` is derived from the kind, not guessed
 *      per-capability. Clients that react to `retriable=true` (e.g.,
 *      a CLI that auto-retries `conflict` / `upstream`) get
 *      consistent signals regardless of which capability threw.
 *
 * Every capability's `effectOnError` should delegate here rather
 * than hand-rolling the envelope. If a capability genuinely needs a
 * custom code, it can wrap the result (`{ ...projectErrorAudit(...),
 * error_code: "custom" }`), which makes the deviation explicit.
 */

import type { AuditError, HandlerError } from "@editorzero/audit";
import type { CapabilityId } from "@editorzero/ids";

export function projectErrorAudit(capability_id: CapabilityId, error: HandlerError): AuditError {
  return {
    kind: "error",
    capability: capability_id,
    error_code: error.kind,
    retriable: retriableForKind(error.kind),
  };
}

/**
 * Per-`HandlerError.kind` retry hint. Exhaustive switch (TS catches
 * a missing branch at compile time) so a new `HandlerError` variant
 * forces a retry-policy decision here.
 *
 *   - `conflict` / `upstream` → retriable. Optimistic CRDT / seq
 *     conflicts clear under a fresh fetch; upstream 502/503 are
 *     transient.
 *   - `validation` / `not_found` / `resource_limit` / `internal`
 *     → not retriable. Caller must change input (validation,
 *     resource_limit), confirm subject (not_found), or wait for
 *     operator action (internal).
 */
function retriableForKind(kind: HandlerError["kind"]): boolean {
  switch (kind) {
    case "conflict":
    case "upstream":
      return true;
    case "validation":
    case "not_found":
    case "resource_limit":
    case "internal":
      return false;
  }
}
