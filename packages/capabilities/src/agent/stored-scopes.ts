/**
 * Parse the `agent_tokens.scopes` JSON column into the typed list (ADR
 * 0044). THE one parser — `agent.token_list` echoes through it, the
 * invariant-3a replay property projects through it, and the increment-4
 * bearer resolver will authorize through it; one closed-vocabulary
 * rule, one place.
 *
 * Unlike `workspaces.settings` (open object — parse-or-fallback),
 * scopes have a CLOSED vocabulary, so a non-conforming value THROWS:
 * the only writer is the mint path, which serializes a validated list —
 * anything else in the column means something wrote outside the owned
 * path, and silently filtering would hide exactly that corruption.
 */

import { SCOPES, type Scope } from "@editorzero/scopes";

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

function isScope(value: unknown): value is Scope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

export function parseStoredScopes(json: string): readonly Scope[] {
  const parsed: unknown = JSON.parse(json);
  if (Array.isArray(parsed)) {
    const scopes = parsed.filter(isScope);
    if (scopes.length === parsed.length) return scopes;
  }
  throw new Error(`agent_tokens.scopes is not a Scope[] — written outside the mint path: ${json}`);
}
