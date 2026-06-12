import { CapabilityId } from "@editorzero/ids";
import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "./default-registry";

// The full shipped capability set. Authored explicitly (not derived from
// the same imports `default-registry.ts` uses) so this is an independent
// check: dropping a `registerCapability(...)` line — or adding one without
// updating the contract — fails here. Update both together on purpose.
const EXPECTED_IDS = [
  "audit.get",
  "audit.list",
  "collection.create",
  "collection.delete",
  "collection.list",
  "collection.move",
  "collection.restore",
  "collection.update",
  "doc.add_guest",
  "doc.create",
  "doc.delete",
  "doc.get",
  "doc.list",
  "doc.move",
  "doc.publish",
  "doc.remove_guest",
  "doc.rename",
  "doc.restore",
  "doc.unpublish",
  "doc.update",
  "permission.grant",
  "permission.list",
  "permission.revoke",
  "space.archive",
  "space.create",
  "space.get",
  "space.list",
  "space.member_add",
  "space.member_remove",
  "space.member_update_role",
  "space.restore",
  "space.update",
  "workspace.get",
  "workspace.member_add",
  "workspace.member_list",
  "workspace.member_remove",
  "workspace.member_update_role",
  "workspace.update",
].map((id) => CapabilityId(id));

describe("createDefaultRegistry", () => {
  it("registers exactly the shipped capability set", () => {
    const registry = createDefaultRegistry();
    // `ids()` is sorted lexicographically; compare against the sorted
    // expectation so order is normalized on both sides.
    expect([...registry.ids()]).toEqual([...EXPECTED_IDS].sort());
  });

  it("returns a fresh, frozen registry per call", () => {
    const a = createDefaultRegistry();
    const b = createDefaultRegistry();
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});
