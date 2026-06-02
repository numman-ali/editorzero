/**
 * System-audit provenance markers (ADR 0041).
 *
 * `SYSTEM_AUDIT_CAPABILITY_IDS` is the SSOT allowlist of synthetic
 * `capability_id` values that may appear on `audit_events` rows written
 * OUTSIDE the dispatcher (signup genesis today; import / repair jobs later).
 * `isSystemAuditCapabilityId` is the runtime half of the "a recognised audit
 * row carries either a registered capability id OR a system-audit id" rule —
 * `scripts/coherence.ts` enforces the build-time half (markers stay disjoint
 * from implemented capabilities). This pins the guard's contract: it is the
 * blessed membership predicate, so downstream code never re-implements
 * `=== "system.workspace_bootstrap"`.
 */

import { describe, expect, it } from "vitest";

import {
  isSystemAuditCapabilityId,
  SYSTEM_AUDIT_CAPABILITY_IDS,
  SYSTEM_WORKSPACE_BOOTSTRAP,
  type SystemAuditCapabilityId,
} from "./index";

describe("system-audit provenance markers (ADR 0041)", () => {
  it("recognises every member of the SSOT allowlist", () => {
    for (const id of SYSTEM_AUDIT_CAPABILITY_IDS) {
      expect(isSystemAuditCapabilityId(id)).toBe(true);
    }
  });

  it("recognises the genesis-bootstrap marker and pins its literal value", () => {
    expect(SYSTEM_WORKSPACE_BOOTSTRAP).toBe("system.workspace_bootstrap");
    expect(isSystemAuditCapabilityId(SYSTEM_WORKSPACE_BOOTSTRAP)).toBe(true);
  });

  it("rejects dispatchable capability ids and look-alike strings", () => {
    // Real, registered capabilities — must never be mistaken for system markers.
    expect(isSystemAuditCapabilityId("doc.create")).toBe(false);
    expect(isSystemAuditCapabilityId("workspace.update")).toBe(false);
    // Empty + near-misses (prefix / suffix drift) stay outside the set.
    expect(isSystemAuditCapabilityId("")).toBe(false);
    expect(isSystemAuditCapabilityId("system.workspace")).toBe(false);
    expect(isSystemAuditCapabilityId("system.workspace_bootstrap_v2")).toBe(false);
  });

  it("narrows the static type on a positive guard", () => {
    const id: string = SYSTEM_WORKSPACE_BOOTSTRAP;
    if (!isSystemAuditCapabilityId(id)) throw new Error("guard must accept the known marker");
    // Assigning to `SystemAuditCapabilityId` compiles ONLY because the
    // predicate narrowed `string` → the literal union (no cast).
    const narrowed: SystemAuditCapabilityId = id;
    expect(narrowed).toBe(SYSTEM_WORKSPACE_BOOTSTRAP);
  });
});
