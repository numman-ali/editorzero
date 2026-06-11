/**
 * `@editorzero/ids` — brand parsers + UUIDv7 generator.
 *
 * `uuidV7` is the only runtime logic in this package; the brand parsers
 * are one-line regex gates. Tests cover the layout the RFC prescribes
 * so downstream code relying on time-sortability (docs listed by
 * creation time without an extra index) holds on fresh IDs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetUuidV7StateForTesting,
  CapabilityId,
  DocId,
  GrantId,
  generateAgentId,
  generateAttachmentId,
  generateBlockId,
  generateCollectionId,
  generateCommentId,
  generateCustomDomainId,
  generateDocId,
  generateGrantId,
  generateMirrorId,
  generateSpaceId,
  generateUploadId,
  generateVersionId,
  generateWebhookId,
  generateWorkspaceId,
  JobId,
  SessionId,
  SpaceId,
  uuidV7,
  WorkspaceId,
} from "./index";

describe("uuidV7", () => {
  const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // Reset the module-level counter before each test so that assertions
  // about timestamp encoding don't get surprised by counter carry-over
  // from a previous test that bumped `lastTs`.
  beforeEach(() => {
    __resetUuidV7StateForTesting();
  });

  it("produces the canonical 8-4-4-4-12 hyphenated shape", () => {
    const id = uuidV7();
    expect(id).toMatch(UUID_V7_RE);
    expect(id.length).toBe(36);
  });

  it("sets the version nibble to 7 (RFC 9562 §5.7)", () => {
    const id = uuidV7();
    // Fourth group is `7xxx`; position 14 in the hyphenated string.
    expect(id[14]).toBe("7");
  });

  it("sets the variant bits to 0b10 (nibble ∈ {8,9,a,b})", () => {
    const id = uuidV7();
    // Fifth group is `Vxxx`; position 19 in the hyphenated string.
    const variantNibble = id[19]?.toLowerCase() ?? "";
    expect(["8", "9", "a", "b"]).toContain(variantNibble);
  });

  it("encodes the current Unix ms timestamp in the first 48 bits", () => {
    const before = Date.now();
    const id = uuidV7();
    const after = Date.now();

    // First 8 chars = hex of ts >> 16; next 4 chars = hex of ts & 0xFFFF.
    const tsHex = id.slice(0, 8) + id.slice(9, 13);
    const ts = Number.parseInt(tsHex, 16);
    // Allow a 5-ms fuzz in case the process scheduler delays us.
    expect(ts).toBeGreaterThanOrEqual(before - 5);
    expect(ts).toBeLessThanOrEqual(after + 5);
  });

  it("is strictly monotone within the same ms (RFC 9562 §6.2 Method 1 counter)", () => {
    // Freeze the clock so every call lands in the same Unix-ms tick.
    // Without the monotonic counter, the tail of the UUID would be
    // fully random and ordering within a burst would be
    // non-deterministic — which would break any consumer using UUIDv7
    // as a list `order_key` (e.g., `docs.order_key` on `doc.list`).
    // This test pins the RFC 9562 §6.2 Method 1 behaviour: same-ms
    // calls produce strictly ascending IDs.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-18T12:00:00.000Z"));
      const ids: string[] = [];
      for (let i = 0; i < 256; i++) ids.push(uuidV7());

      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries monotonicity across a ms boundary (later ms sorts above earlier)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-18T12:00:00.000Z"));
      const first = uuidV7();
      // Advance the fake clock past the current ms.
      vi.setSystemTime(new Date("2026-04-18T12:00:00.001Z"));
      const second = uuidV7();
      expect(second > first).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances the logical ms when the intra-ms counter wraps (overflow safety)", () => {
    // The counter is 12 bits (4096 slots). A fresh ms seeds in the
    // lower half so the next >=2048 calls stay in-ms; beyond that,
    // the counter wraps and the generator advances `lastTs` by 1 to
    // keep strict monotonicity. Real wall-clock catches up on the
    // next natural tick. This test exercises > 4096 calls in a
    // single frozen ms to cover the wrap path explicitly.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-18T12:00:00.000Z"));
      const ids: string[] = [];
      for (let i = 0; i < 5000; i++) ids.push(uuidV7());
      // All IDs remain strictly ascending across the wrap.
      let prev = "";
      for (const id of ids) {
        expect(id > prev).toBe(true);
        prev = id;
      }
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits distinct IDs across many calls in real time", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(uuidV7());
    expect(ids.size).toBe(1000);
  });
});

describe("generateDocId and sibling generators", () => {
  it("returns a branded DocId whose value parses through the parser idempotently", () => {
    const id = generateDocId();
    expect(DocId(id)).toBe(id);
  });

  it("each sibling generator returns a valid UUIDv7 branded as its own type", () => {
    // A compact sanity pass — each generator pairs with its parser.
    // Drift (e.g. forgetting to flip the version nibble) would throw at
    // parse time, which is the point of the round-trip.
    expect(() => generateDocId()).not.toThrow();
    expect(() => generateWorkspaceId()).not.toThrow();
    expect(() => generateCollectionId()).not.toThrow();
    expect(() => generateBlockId()).not.toThrow();
    expect(() => generateAgentId()).not.toThrow();
    expect(() => generateCommentId()).not.toThrow();
    expect(() => generateAttachmentId()).not.toThrow();
    expect(() => generateUploadId()).not.toThrow();
    expect(() => generateVersionId()).not.toThrow();
    expect(() => generateMirrorId()).not.toThrow();
    expect(() => generateCustomDomainId()).not.toThrow();
    expect(() => generateWebhookId()).not.toThrow();
    expect(() => generateSpaceId()).not.toThrow();
    expect(() => generateGrantId()).not.toThrow();
  });
});

describe("brand parsers (sanity — full coverage in call-site tests)", () => {
  it("DocId rejects a UUIDv4 shape because product IDs must be v7", () => {
    // Version nibble 4, variant nibble 'a' → valid v4, NOT v7.
    expect(() => DocId("018f0000-0000-4000-a000-000000000001")).toThrow(/non-v7/);
  });

  it("DocId rejects a non-UUID string outright", () => {
    expect(() => DocId("not a uuid")).toThrow(/invalid UUID/);
  });

  it("WorkspaceId round-trips a known-valid v7 hyphenated id", () => {
    const raw = "018f0000-0000-7000-8000-000000000001";
    expect(WorkspaceId(raw)).toBe(raw);
  });

  it("SessionId accepts Better Auth's UUIDv4 (product-owned vs BA-owned split)", () => {
    // Better Auth rows (session, account) may carry UUIDv4; the
    // parser's `parseAny` allows any valid UUID shape so the adapter
    // seam doesn't crash on foreign-owned rows.
    const raw = "018f0000-0000-4000-a000-000000000001";
    expect(SessionId(raw)).toBe(raw);
  });

  it("CapabilityId enforces the dot-separated snake-case shape", () => {
    expect(CapabilityId("doc.create")).toBe("doc.create");
    expect(() => CapabilityId("Doc.Create")).toThrow(/invalid CapabilityId/);
    expect(() => CapabilityId("nodots")).toThrow(/invalid CapabilityId/);
  });

  it("JobId is driver-specific: no runtime assertion, brand cast only", () => {
    expect(JobId("whatever-the-queue-emits")).toBe("whatever-the-queue-emits");
  });

  it("SpaceId / GrantId are product-owned v7 parsers (ADR 0040 Step 3)", () => {
    const raw = "018f0000-0000-7000-8000-000000000001";
    expect(SpaceId(raw)).toBe(raw);
    expect(GrantId(raw)).toBe(raw);
    const v4 = "018f0000-0000-4000-a000-000000000001";
    expect(() => SpaceId(v4)).toThrow(/non-v7/);
    expect(() => GrantId(v4)).toThrow(/non-v7/);
  });
});
