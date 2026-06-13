/**
 * Token-crypto pins (ADR 0044 Decision 1). The format is a CONTRACT —
 * secret scanners match the prefix, the resolver discriminates on it,
 * and the schema's UNIQUE(token_hash) assumes the hash shape — so the
 * pins are exact, not approximate.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AGENT_TOKEN_LENGTH,
  AGENT_TOKEN_PREFIX,
  AGENT_TOKEN_SECRET_LENGTH,
  hashAgentToken,
  isWellFormedAgentToken,
  mintAgentToken,
} from "./token-crypto";

describe("mintAgentToken (ADR 0044)", () => {
  it("mints ez_agent_ + 43 base62 chars, every time", () => {
    for (let i = 0; i < 200; i++) {
      const minted = mintAgentToken();
      expect(minted.token).toMatch(/^ez_agent_[0-9A-Za-z]{43}$/);
      expect(minted.token).toHaveLength(AGENT_TOKEN_LENGTH);
    }
  });

  it("derives hash, prefix, and last4 from the token — and nothing leaks the secret", () => {
    const minted = mintAgentToken();
    expect(minted.token_hash).toBe(createHash("sha256").update(minted.token).digest("hex"));
    expect(minted.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.token_prefix).toBe(minted.token.slice(0, 12));
    expect(minted.token_prefix.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(minted.last4).toBe(minted.token.slice(-4));
    // Display identity exposes 3 + 4 secret chars of 43 — the other 36
    // (~214 bits) stay secret; the hash is one-way. Nothing else exists.
    expect(Object.keys(minted).sort()).toEqual(["last4", "token", "token_hash", "token_prefix"]);
  });

  it("hashAgentToken is deterministic and matches mint-time hashing (the resolver contract)", () => {
    const minted = mintAgentToken();
    expect(hashAgentToken(minted.token)).toBe(minted.token_hash);
    expect(hashAgentToken("ez_agent_other")).not.toBe(minted.token_hash);
  });

  it("collides never in a sane sample (256-bit entropy smoke)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintAgentToken().token);
    expect(seen.size).toBe(1000);
  });

  it("draws from the full base62 alphabet (rejection sampling does not truncate the range)", () => {
    // 200 tokens × 43 chars = 8600 draws; every one of the 62 chars has
    // P(absent) ≈ (61/62)^8600 ≈ 10^-61 — absence means a broken sampler.
    const chars = new Set<string>();
    for (let i = 0; i < 200; i++) {
      for (const c of mintAgentToken().token.slice(AGENT_TOKEN_PREFIX.length)) chars.add(c);
    }
    expect(chars.size).toBe(62);
  });
});

describe("isWellFormedAgentToken — the resolver's pre-hash shape gate (ADR 0044)", () => {
  const body43 = "A".repeat(AGENT_TOKEN_SECRET_LENGTH);

  it("accepts a freshly minted token, every time", () => {
    for (let i = 0; i < 200; i++) {
      expect(isWellFormedAgentToken(mintAgentToken().token)).toBe(true);
    }
  });

  it("accepts prefix + exactly 43 base62 chars", () => {
    expect(isWellFormedAgentToken(`${AGENT_TOKEN_PREFIX}${body43}`)).toBe(true);
  });

  it("rejects a string without the prefix", () => {
    expect(isWellFormedAgentToken(body43)).toBe(false);
    expect(isWellFormedAgentToken(`api_key_${body43}`)).toBe(false);
  });

  it("rejects a body that is too short or too long", () => {
    expect(isWellFormedAgentToken(`${AGENT_TOKEN_PREFIX}${"A".repeat(42)}`)).toBe(false);
    expect(isWellFormedAgentToken(`${AGENT_TOKEN_PREFIX}${"A".repeat(44)}`)).toBe(false);
  });

  it("rejects a body with a non-base62 char (right length)", () => {
    // 42 base62 chars + one disallowed char each — '_' '-' '+' '/' are
    // exactly the chars a tokenish-but-foreign credential might carry.
    for (const bad of ["_", "-", "+", "/"]) {
      expect(isWellFormedAgentToken(`${AGENT_TOKEN_PREFIX}${"A".repeat(42)}${bad}`)).toBe(false);
    }
  });

  it("rejects the bare prefix and the empty string", () => {
    expect(isWellFormedAgentToken(AGENT_TOKEN_PREFIX)).toBe(false);
    expect(isWellFormedAgentToken("")).toBe(false);
  });
});
