/**
 * Route-boundary error mapping for the code-first surface (ADR 0029 §4).
 *
 * `hc<AppType>` infers a route's error arm **only** from the handler's
 * explicit `c.json(body, status)` returns — a `describeRoute` response
 * *declaration* documents OpenAPI but does not feed `hc`, and a global
 * `onError` / middleware return is invisible to it. So every capability
 * route catches the dispatcher's thrown `EditorZeroError` and maps it here
 * to an explicit, literal-typed `{ error: code }` envelope — the single
 * discriminated shape the CLI / MCP / UI all consume (ADR 0033). The
 * dispatcher still *throws* (its contract is unchanged — CLI and MCP share
 * it); this helper is the API surface's route-level projection of those
 * throws into typed responses.
 *
 * 500-class and unknown errors rethrow so the trunk's minimal `onError`
 * owns them (PG-retryable → 409 conflict; otherwise Hono's default 500).
 * Those are not typed client arms.
 *
 * Verified hc-visible through this helper indirection: a handler doing
 * `catch (err) { return errorResponse(c, err); }` surfaces the full error
 * union on `client.<route>` (spike4, 2026-05-30).
 */

import {
  ConflictError,
  HasLiveDescendantsError,
  LastOwnerError,
  MemberAlreadyExistsError,
  NotFoundError,
  ParentDeletedError,
  PermissionDeniedError,
  RateLimitError,
  ResourceLimitError,
  SlugCollisionError,
  StalePreconditionError,
  UpstreamError,
  ValidationError,
} from "@editorzero/errors";
import type { Context } from "hono";

import type { ApiEnv } from "../env";

export function errorResponse(c: Context<ApiEnv>, err: unknown) {
  if (err instanceof ValidationError) return c.json({ error: "validation_failed" } as const, 400);
  if (err instanceof PermissionDeniedError)
    return c.json({ error: "permission_denied" } as const, 403);
  if (err instanceof NotFoundError) return c.json({ error: "not_found" } as const, 404);
  if (err instanceof ConflictError) return c.json({ error: "conflict" } as const, 409);
  if (err instanceof StalePreconditionError)
    return c.json({ error: "stale_precondition" } as const, 409);
  if (err instanceof ParentDeletedError) return c.json({ error: "parent_deleted" } as const, 409);
  if (err instanceof HasLiveDescendantsError)
    return c.json({ error: "has_live_descendants" } as const, 409);
  if (err instanceof LastOwnerError) return c.json({ error: "last_owner_protected" } as const, 409);
  if (err instanceof MemberAlreadyExistsError)
    return c.json({ error: "member_already_exists" } as const, 409);
  if (err instanceof SlugCollisionError) return c.json({ error: "slug_collision" } as const, 409);
  if (err instanceof RateLimitError) return c.json({ error: "rate_limited" } as const, 429);
  if (err instanceof ResourceLimitError) return c.json({ error: "resource_limit" } as const, 413);
  if (err instanceof UpstreamError) return c.json({ error: "upstream_error" } as const, 502);
  // InternalError, TransactCalledTwiceError, PG-retryable, and unknown errors
  // are not typed client arms — let the trunk's onError own them.
  throw err;
}
