/**
 * Wire-error projection shared by the SPA data-layer modules (session,
 * docs, …). Extracted from `session.ts` when the second consumer arrived —
 * one reader for the `{ error }` envelope, not a copy per module.
 */

/**
 * Read a `{ error: string }` envelope from an unknown body, cast-free: the `in`
 * operator narrows `body` to `{ error: unknown }` (TS 4.9+), so `body.error` is
 * a named-property access — no `as`, and not an index-signature access.
 */
function readStringError(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return undefined;
}

/**
 * Best-effort wire error code for a non-ok response. Prefers the `{ error }`
 * envelope; falls back to `"unauthenticated"` for a 401 (the middleware
 * shape) or `"request_failed"` for an untyped / non-JSON response.
 */
export async function readErrorCode(res: Response): Promise<string> {
  try {
    const fromBody = readStringError(await res.json());
    if (fromBody !== undefined) {
      return fromBody;
    }
  } catch {
    // Non-JSON error body (e.g. an HTML 5xx from the trunk). Fall through.
  }
  return res.status === 401 ? "unauthenticated" : "request_failed";
}
