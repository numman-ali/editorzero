/**
 * Block-content hashing (ADR 0022 §57) — isomorphic.
 *
 * `expect_prior_content_hash` preconditions are computed on the server
 * (the `doc.update` applier verifying them) AND in the browser (the
 * Web UI editor stamping the hash of the state it loaded, so a lost
 * update surfaces as a 409 instead of a silent clobber). One
 * implementation serves both: SHA-256 via `globalThis.crypto.subtle`
 * (WebCrypto — present in Node ≥ 19 and every target browser), which
 * is why these helpers are async. This file replaced the node:crypto
 * copy that lived inline in `packages/capabilities/src/doc/update.ts`
 * the moment the browser became the second consumer.
 *
 * Hash shape: canonical JSON of `{ type, props, content }` — the
 * block's *editable* state. `id`, structural metadata (parent /
 * order_key), and visibility are excluded so a move or visibility op
 * never invalidates an in-flight update's precondition (content, not
 * location — ADR 0022).
 */

/** Recursively key-sort; produces canonical JSON under `JSON.stringify`. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const plain = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(plain).sort()) sorted[key] = canonicalize(plain[key]);
  return sorted;
}

export async function stableHash(input: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(input)) ?? "";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hashBlockContent(block: {
  readonly type: string;
  readonly props?: unknown;
  readonly content?: unknown;
}): Promise<string> {
  return stableHash({ type: block.type, props: block.props, content: block.content });
}
