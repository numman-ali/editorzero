/**
 * `ApiError` — the client-side projection of the api-server's typed error
 * envelope (`{ error: code }`, ADR 0033 / `errorResponse` in
 * packages/api-server/src/lib/errors.ts).
 *
 * Lives in `@editorzero/api-client` — not `apps/app`, not `@editorzero/errors`
 * — because it is the thin, browser-safe CLIENT throwable every typed-RPC
 * consumer shares: the Web UI's react-query `queryFn`s reject with it today,
 * and the CLI will reject with it when it stops hand-rolling `emitError`.
 * `@editorzero/errors` is server-only by intent — its `EditorZeroError`
 * subclasses depend on `@editorzero/ids` + `@editorzero/scopes` and hold server
 * context. `ApiError` carries only what crosses the wire: a status and a code.
 */

/**
 * The typed capability error codes `errorResponse` emits
 * (packages/api-server/src/lib/errors.ts). This array is the in-package SSOT;
 * `ApiErrorCode` is derived from it (one list, no intra-file drift), and
 * `pnpm coherence` (Check 10) diffs it against the server's
 * `{ error: "…" } as const` literals so a new error class cannot drift the
 * client vocabulary out of sync.
 *
 * Deliberately NOT members: `unauthenticated` — the principal-middleware 401
 * emitted before any handler runs, absent from every `hc` typed arm; and the
 * untyped 5xx family (`internal_error`, transact-twice, unknown) the trunk
 * `onError` owns. Those still reach `ApiError.code` as raw strings — they are
 * just not *typed* codes.
 */
export const API_ERROR_CODES = [
  "validation_failed",
  "permission_denied",
  "not_found",
  "conflict",
  "grant_lifecycle_conflict",
  "stale_precondition",
  "parent_deleted",
  "has_live_descendants",
  "last_owner_protected",
  "member_already_exists",
  "slug_collision",
  "resource_limit",
  "rate_limited",
  "upstream_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Narrow a raw wire `code` (`string`) to a typed `ApiErrorCode` without a cast.
 * The `.some` + `===` form keeps the literal-union element type;
 * `API_ERROR_CODES.includes(value)` would reject a `string` argument and force
 * an `as`. Returns `false` for `unauthenticated` / `request_failed` / unknown.
 */
export function isApiErrorCode(value: string): value is ApiErrorCode {
  return API_ERROR_CODES.some((code) => code === value);
}

/**
 * The throwable typed-RPC consumers reject/throw with. `code` is intentionally
 * a raw `string`, not `ApiErrorCode`: three runtime sources feed it and only
 * capability arms are typed members — the middleware 401 (`unauthenticated`)
 * and untyped 5xx (`request_failed`) are not. Narrowing the field would force
 * an `as` at construction; a consumer that needs a typed code narrows via
 * `isApiErrorCode(err.code)`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`ApiError ${status}: ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** `instanceof` guard so a component catch-site narrows `unknown` cast-free. */
export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
