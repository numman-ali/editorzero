import { describe, expect, it } from "vitest";

import { isReservedApiPath, RESERVED_API_PREFIXES } from "./reserved-prefixes";

describe("reserved API prefixes (ADR 0035 §2)", () => {
  it("pins the trunk-owned prefix set", () => {
    // The five capability domains + the three framework-owned prefixes.
    expect([...RESERVED_API_PREFIXES]).toEqual([
      "/infra",
      "/docs",
      "/collections",
      "/workspaces",
      "/audit",
      "/auth",
      "/mcp",
      "/collab",
    ]);
  });

  it("matches a reserved prefix exactly and its children", () => {
    expect(isReservedApiPath("/docs")).toBe(true);
    expect(isReservedApiPath("/docs/018f-…")).toBe(true);
    expect(isReservedApiPath("/collab")).toBe(true);
  });

  it("does not match SPA routes or letter-prefix near-misses", () => {
    expect(isReservedApiPath("/")).toBe(false);
    expect(isReservedApiPath("/login")).toBe(false);
    // `/documentation` starts with the letters of `/docs` but is not a child —
    // the boundary is `/` or end-of-string, not a substring.
    expect(isReservedApiPath("/documentation")).toBe(false);
  });
});
