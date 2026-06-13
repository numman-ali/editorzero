/**
 * ADR 0044 Decision 1 — the non-amplification rule's vocabulary half.
 * The mint-time subset rule (an agent caller mints ⊆ its own effective
 * scopes) is pinned at the `agent.token_mint` capability; these pins
 * cover the universe itself.
 */

import { describe, expect, it } from "vitest";

import { AGENT_MINTABLE_SCOPES, AGENT_SCOPE_TIERS, SCOPES } from "./index";

describe("AGENT_MINTABLE_SCOPES (ADR 0044)", () => {
  it("is exactly SCOPES minus the literal 'admin' scope", () => {
    expect(AGENT_MINTABLE_SCOPES).toEqual(SCOPES.filter((s) => s !== "admin"));
    expect(AGENT_MINTABLE_SCOPES).not.toContain("admin");
    expect(AGENT_MINTABLE_SCOPES).toHaveLength(SCOPES.length - 1);
  });

  it("every named tier is mintable — no tier bundle escapes the universe", () => {
    const mintable = new Set<string>(AGENT_MINTABLE_SCOPES);
    for (const [tier, scopes] of Object.entries(AGENT_SCOPE_TIERS)) {
      for (const scope of scopes) {
        expect(mintable.has(scope), `tier ${tier} carries unmintable scope ${scope}`).toBe(true);
      }
    }
  });
});
