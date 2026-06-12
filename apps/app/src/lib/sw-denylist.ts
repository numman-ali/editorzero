import { RESERVED_API_PREFIXES } from "@editorzero/constants/reserved-prefixes";

/**
 * The service worker's navigation denylist, DERIVED from the ADR 0035 §2
 * reserved-prefix SSOT (ADR 0039 §1). Drift here is security-relevant: a
 * dropped prefix would serve the cached app-shell HTML for an API/auth
 * navigation offline — a correctness break dressed as a 200.
 *
 * Deriving (instead of hand-listing) makes the drift impossible by
 * construction; the unit test pins the MATCHING SEMANTICS, which is the
 * part a refactor could silently weaken.
 *
 * Workbox's `NavigationRoute` tests each RegExp against the concatenated
 * `pathname + search` of the requested URL (workbox-routing docs), so the
 * boundary after the prefix must accept `/` (deeper path), `?` (query on
 * the prefix root) or end-of-string — and nothing else: `/authx` is a
 * legitimate client route, `/auth?x=1` is the trunk's.
 *
 * The same subpath import as vite.config.ts: `reserved-prefixes` is the
 * import-free leaf module, loadable everywhere (config, SW bundle, tests)
 * without dragging the package barrel in.
 */
export function reservedPrefixDenylist(): RegExp[] {
  return RESERVED_API_PREFIXES.map((prefix) => new RegExp(`^${prefix}(?:[/?]|$)`));
}
