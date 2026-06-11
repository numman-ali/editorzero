/**
 * Grant vocabulary pins (ADR 0040 Step 3).
 *
 * `GRANT_ROLES` and the workspace `ROLES` are different vocabularies that
 * happen to share the word "owner" — ADR 0040 names conflating them a real
 * drift hazard and mandates a separate pin. These tests freeze the exact
 * membership of each new enumeration so a "helpful" widening or merge
 * shows up as a failing diff, not silent drift. The reserved metadata-only
 * ids are pinned too: they must stay inside the capability-id grammar or
 * the Step-8 `registerCapability` calls would reject them.
 */

import { describe, expect, it } from "vitest";

import {
  ACCESS_MODES,
  GRANT_ROLES,
  isMetadataOnlyCapability,
  METADATA_ONLY_CAPABILITIES,
  ROLES,
  SUBJECT_KINDS,
} from "./index";

describe("grant vocabulary (ADR 0040 Step 3)", () => {
  it("pins GRANT_ROLES exactly — positive-only, no deny member (fork #5)", () => {
    expect(GRANT_ROLES).toEqual(["owner", "edit", "comment", "view"]);
  });

  it("GRANT_ROLES is a distinct vocabulary from the workspace ROLES", () => {
    // Same-set equality would mean someone collapsed the two enums.
    expect(new Set<string>(GRANT_ROLES)).not.toEqual(new Set<string>(ROLES));
    // The workspace-only roles never leak into the grant vocabulary.
    expect(GRANT_ROLES).not.toContain("admin");
    expect(GRANT_ROLES).not.toContain("member");
    expect(GRANT_ROLES).not.toContain("guest");
  });

  it("pins ACCESS_MODES exactly (doc-level mode switch, fork #5 resolution)", () => {
    expect(ACCESS_MODES).toEqual(["space", "private"]);
  });

  it("SUBJECT_KINDS gained the space/grant audit subjects (team waits for Teams)", () => {
    expect(SUBJECT_KINDS).toContain("space");
    expect(SUBJECT_KINDS).toContain("grant");
    expect(SUBJECT_KINDS).not.toContain("team");
  });

  it("recognises the reserved Step-8 metadata-only mutators", () => {
    const reserved = [
      "permission.grant",
      "permission.revoke",
      "space.create",
      "space.update",
      "space.archive",
      "space.restore",
      "space.member_add",
      "space.member_remove",
      "space.member_update_role",
      "doc.add_guest",
      "doc.remove_guest",
    ];
    for (const id of reserved) {
      expect(isMetadataOnlyCapability(id)).toBe(true);
    }
    // Reads are never metadata-only mutators.
    expect(isMetadataOnlyCapability("permission.list")).toBe(false);
    expect(isMetadataOnlyCapability("doc.list_grants")).toBe(false);
  });

  it("every metadata-only id stays inside the capability-id grammar", () => {
    for (const id of METADATA_ONLY_CAPABILITIES) {
      expect(id).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});
