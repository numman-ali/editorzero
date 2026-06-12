import { RESERVED_API_PREFIXES } from "@editorzero/constants/reserved-prefixes";
import { describe, expect, it } from "vitest";

import { reservedPrefixDenylist } from "./sw-denylist";

/**
 * ADR 0039 §1: "the denylist is derived from the SAME ADR 0035 §2
 * reserved-prefix SSOT — plus a test asserting the two lists match."
 * Derivation makes list drift impossible; what remains testable (and
 * security-relevant) is the per-prefix matching semantics against
 * workbox's `pathname + search` match target.
 */
describe("reservedPrefixDenylist", () => {
  it("derives exactly one matcher per reserved prefix, in SSOT order", () => {
    const denylist = reservedPrefixDenylist();
    expect(denylist).toHaveLength(RESERVED_API_PREFIXES.length);
    for (const [i, prefix] of RESERVED_API_PREFIXES.entries()) {
      // Compare via an identically-constructed RegExp — `source` escapes
      // the path slashes, so a raw-string startsWith would always miss.
      expect(denylist[i]?.source).toBe(new RegExp(`^${prefix}(?:[/?]|$)`).source);
    }
  });

  it("matches the prefix root, deeper paths, and the prefix root with a query", () => {
    const denylist = reservedPrefixDenylist();
    for (const [i, prefix] of RESERVED_API_PREFIXES.entries()) {
      const matcher = denylist[i];
      if (matcher === undefined) throw new Error(`no matcher for ${prefix}`);
      // Workbox tests `pathname + search` — cover all three boundary forms.
      expect(matcher.test(prefix)).toBe(true);
      expect(matcher.test(`${prefix}/deeper/path`)).toBe(true);
      expect(matcher.test(`${prefix}?q=1`)).toBe(true);
    }
  });

  it("does NOT match client routes that merely share the prefix's spelling", () => {
    const denylist = reservedPrefixDenylist();
    for (const [i, prefix] of RESERVED_API_PREFIXES.entries()) {
      const matcher = denylist[i];
      if (matcher === undefined) throw new Error(`no matcher for ${prefix}`);
      // `/docsy` must stay a client navigation even though `/docs` is
      // reserved; same for every prefix. And nothing matches mid-path.
      expect(matcher.test(`${prefix}y`)).toBe(false);
      expect(matcher.test(`/app${prefix}`)).toBe(false);
    }
  });

  it("keeps the editor route's singular spelling out of the reserved set", () => {
    // The slice-B route is `/doc/$docId` PRECISELY because `/docs` is
    // reserved (ADR 0035 §2). If this ever flips, the navigation route
    // would stop serving the editor offline — pin it.
    const denylist = reservedPrefixDenylist();
    expect(denylist.some((matcher) => matcher.test("/doc/0190-abc"))).toBe(false);
  });

  it("keeps the Spaces route's singular spelling out of the reserved set", () => {
    // Same resolution for the space.list cell: the screen is `/space`
    // because `/spaces` is the trunk's API domain — the SW must keep
    // serving the client route offline while bypassing the API prefix.
    const denylist = reservedPrefixDenylist();
    expect(denylist.some((matcher) => matcher.test("/space"))).toBe(false);
    expect(denylist.some((matcher) => matcher.test("/spaces/list"))).toBe(true);
  });
});
