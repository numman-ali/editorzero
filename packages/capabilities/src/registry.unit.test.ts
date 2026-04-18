import { CapabilityId } from "@editorzero/ids";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Capability } from "./kernel";
import { createRegistry, RegistryLookupError, registerCapability } from "./registry";

/**
 * Minimum-viable registered capability for registry tests. None of the
 * runtime behaviour is exercised — the registry only reads `id` — but
 * the object goes through `registerCapability(typedCapability)` so any
 * drift on `Capability<I, O>`'s shape surfaces at author time, not at
 * dispatch time. No casts.
 */
function stubCapability(id: string) {
  const typed: Capability<Record<string, never>, Record<string, never>> = {
    id: CapabilityId(id),
    category: "read",
    summary: `stub capability ${id}`,
    input: z.object({}).strict(),
    output: z.object({}).strict(),
    requires: [],
    audit: {
      subjectFrom: () => ({ kind: "workspace" }),
      effectOnAllow: () => ({ kind: "audit.access_log" }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: CapabilityId(id),
        required_scopes: [],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: CapabilityId(id),
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: ["api"],
    handler: async () => ({}),
  };
  return registerCapability(typed);
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
      // `instanceof` narrows `err: unknown` to `RegistryLookupError`
      // without casts — the subclass carries typed fields.
      expect(err).toBeInstanceOf(RegistryLookupError);
      if (err instanceof RegistryLookupError) {
        expect(err.name).toBe("RegistryLookupError");
        expect(err.capability_id).toBe("doc.read");
      }
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
