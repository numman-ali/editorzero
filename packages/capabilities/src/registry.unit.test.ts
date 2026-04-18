import { CapabilityId } from "@editorzero/ids";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AnyCapability, Capability } from "./kernel";
import { createRegistry } from "./registry";

/**
 * Minimum-viable capability factory for registry tests. None of the
 * runtime fields are exercised here — the registry only cares about
 * `id` — but we construct a spec-compliant `Capability` so type drift
 * on the shape breaks the test at author time, not at dispatch time.
 */
function stubCapability(id: string): AnyCapability {
  const cap: Capability<unknown, unknown> = {
    id: CapabilityId(id),
    category: "query",
    summary: `stub capability ${id}`,
    input: z.object({}).passthrough(),
    output: z.object({}).passthrough(),
    requires: [],
    audit: {
      subjectFrom: () => ({ kind: "workspace" }),
      effectOnAllow: () => ({ kind: "observation", capability_id: CapabilityId(id) }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability_id: CapabilityId(id),
        reason,
      }),
      effectOnError: (_input, error) => ({
        kind: "error",
        capability_id: CapabilityId(id),
        error,
      }),
      collapsePolicy: "per-call",
    },
    surfaces: ["api"],
    handler: async () => ({}),
  };
  return cap as AnyCapability;
}

describe("createRegistry", () => {
  it("exposes capabilities by id", () => {
    const registry = createRegistry([stubCapability("doc.create"), stubCapability("doc.read")]);

    expect(registry.has(CapabilityId("doc.create"))).toBe(true);
    expect(registry.lookup(CapabilityId("doc.read"))?.id).toBe("doc.read");
    expect(registry.require(CapabilityId("doc.create")).summary).toContain("doc.create");
  });

  it("returns undefined for unknown ids via lookup", () => {
    const registry = createRegistry([stubCapability("doc.create")]);
    expect(registry.lookup(CapabilityId("doc.read"))).toBeUndefined();
  });

  it("throws RegistryLookupError for unknown ids via require", () => {
    const registry = createRegistry([stubCapability("doc.create")]);
    expect(() => registry.require(CapabilityId("doc.read"))).toThrowError(/not found/);

    try {
      registry.require(CapabilityId("doc.read"));
      expect.fail("expected require to throw");
    } catch (err) {
      expect((err as Error).name).toBe("RegistryLookupError");
      expect((err as { capability_id: string }).capability_id).toBe("doc.read");
    }
  });

  it("returns ids sorted lexicographically for deterministic output", () => {
    const registry = createRegistry([
      stubCapability("workspace.create"),
      stubCapability("doc.create"),
      stubCapability("doc.read"),
    ]);
    expect(registry.ids()).toEqual(["doc.create", "doc.read", "workspace.create"]);
  });

  it("aligns list() / entries() with ids() order", () => {
    const registry = createRegistry([
      stubCapability("workspace.create"),
      stubCapability("doc.create"),
    ]);
    const ids = registry.ids();
    const listIds = registry.list().map((c) => c.id);
    const entryIds = registry.entries().map(([id]) => id);
    expect(listIds).toEqual(ids);
    expect(entryIds).toEqual(ids);
  });

  it("throws on duplicate capability ids", () => {
    expect(() =>
      createRegistry([stubCapability("doc.create"), stubCapability("doc.create")]),
    ).toThrowError(/Duplicate capability id/);
  });

  it("is frozen after construction", () => {
    const registry = createRegistry([stubCapability("doc.create")]);
    expect(Object.isFrozen(registry)).toBe(true);
  });
});
