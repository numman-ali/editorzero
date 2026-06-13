/**
 * Agent bearer-token crypto (ADR 0044 Decision 1) — the owned cost of
 * not adopting `@better-auth/api-key`, named so it is built and tested
 * deliberately.
 *
 * **Format**: `ez_agent_` + 43 base62 chars. 43 × log2(62) ≈ 256 bits
 * of entropy, drawn via REJECTION SAMPLING over `crypto.randomBytes`
 * (bytes ≥ 248 are discarded; 248 = 62 × 4, so the kept range maps to
 * the 62-char alphabet without modulo bias). The fixed prefix is the
 * secret-scanner contract (the GitHub-PAT pattern) and the resolver's
 * cheap lane discriminator.
 *
 * **Storage**: `sha256(secret)` hex, under the schema's GLOBAL UNIQUE
 * constraint. High-entropy random tokens need a fast hash, not a KDF —
 * the attack bound is brute force against 2²⁵⁶, not dictionaries.
 * Verification is the unique-index probe on the full digest; the
 * security property is deliberately NOT a constant-time string compare
 * (no memcmp exists — and a full-digest probe exposes no partial-match
 * oracle). HMAC-with-server-pepper is a named revisit trigger, not v1.
 *
 * **Display identity**: the first 12 chars of the full token
 * (`ez_agent_` + 3 secret chars — never enough to verify against) plus
 * the last 4, for humane listing without the secret.
 *
 * The plaintext exists ONLY in `agent.token_mint`'s output (show-once).
 * Nothing in this module logs, and the only persistence-shaped value it
 * returns is the hash.
 */

import { createHash, randomBytes } from "node:crypto";

export const AGENT_TOKEN_PREFIX = "ez_agent_";

/** 43 base62 chars ≈ 256 bits (43 × 5.954). */
export const AGENT_TOKEN_SECRET_LENGTH = 43;

/** Total token length: prefix (9) + secret chars (43). */
export const AGENT_TOKEN_LENGTH = AGENT_TOKEN_PREFIX.length + AGENT_TOKEN_SECRET_LENGTH;

/** First 12 chars of the full token — the display prefix column. */
export const AGENT_TOKEN_DISPLAY_PREFIX_LENGTH = 12;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Largest multiple of 62 that fits in a byte — values at/above are rejected. */
const REJECTION_BOUND = 248;

/**
 * Draw `length` unbiased base62 chars. Each byte maps to one char;
 * bytes in [248, 255] are discarded (rejection sampling — taking them
 * mod 62 would over-weight chars 0–7). Expected waste is 8/256 ≈ 3%,
 * so the 2× over-draw makes a second draw vanishingly rare.
 */
function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const byte of bytes) {
      if (byte >= REJECTION_BOUND) continue;
      out += BASE62[byte % BASE62.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export interface MintedAgentToken {
  /** The full plaintext bearer secret — show-once, never persisted. */
  readonly token: string;
  /** SHA-256 hex of the full token — the only stored verifier. */
  readonly token_hash: string;
  /** First 12 chars of the full token — display identity. */
  readonly token_prefix: string;
  /** Last 4 chars — display identity. */
  readonly last4: string;
}

/** SHA-256 hex of a presented bearer string — the resolver's lookup key. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Base62 secret body — the character class `randomBase62` draws from. */
const AGENT_TOKEN_BODY = /^[0-9A-Za-z]+$/;

/**
 * Is `value` a well-formed agent token by SHAPE — `AGENT_TOKEN_PREFIX` +
 * exactly `AGENT_TOKEN_SECRET_LENGTH` base62 chars? The bearer resolver
 * (ADR 0044 Decision 4) gates on this BEFORE hashing, so a malformed
 * prefixed string 401s without hashing arbitrary-length input or probing
 * the GLOBAL-UNIQUE index. SHAPE only — a well-formed token still
 * resolves to nothing unless its hash matches a live row; this is the
 * format contract made real at the resolver boundary, not a validity
 * check.
 */
export function isWellFormedAgentToken(value: string): boolean {
  if (!value.startsWith(AGENT_TOKEN_PREFIX)) return false;
  const body = value.slice(AGENT_TOKEN_PREFIX.length);
  return body.length === AGENT_TOKEN_SECRET_LENGTH && AGENT_TOKEN_BODY.test(body);
}

export function mintAgentToken(): MintedAgentToken {
  const token = `${AGENT_TOKEN_PREFIX}${randomBase62(AGENT_TOKEN_SECRET_LENGTH)}`;
  return {
    token,
    token_hash: hashAgentToken(token),
    token_prefix: token.slice(0, AGENT_TOKEN_DISPLAY_PREFIX_LENGTH),
    last4: token.slice(-4),
  };
}
