import type { Capability } from "@editorzero/capabilities";
import { registerCapability } from "@editorzero/capabilities";
import { CapabilityId } from "@editorzero/ids";
import type { Surface } from "@editorzero/scopes";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { isMcpTool } from "./tool-filter";

function makeCap(opts: { id?: string; surfaces: readonly Surface[]; humanOnly?: boolean }) {
  const typed: Capability<Record<string, never>, Record<string, never>> = {
    id: CapabilityId(opts.id ?? "doc.test"),
    category: "read",
    summary: "stub",
    input: z.object({}).strict(),
    output: z.object({}).strict(),
    requires: [],
    ...(opts.humanOnly !== undefined && { humanOnly: opts.humanOnly }),
    audit: {
      subjectFrom: () => ({ kind: "workspace" }),
      effectOnAllow: () => ({ kind: "audit.access_log" }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: CapabilityId(opts.id ?? "doc.test"),
        required_scopes: [],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: CapabilityId(opts.id ?? "doc.test"),
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: opts.surfaces,
    handler: async () => ({}),
  };
  return registerCapability(typed);
}

describe("isMcpTool", () => {
  it("accepts a capability that lists 'mcp' in surfaces and is not humanOnly", () => {
    expect(isMcpTool(makeCap({ surfaces: ["mcp"] }))).toBe(true);
  });

  it("accepts a capability that lists 'mcp' alongside other surfaces", () => {
    expect(isMcpTool(makeCap({ surfaces: ["api", "cli", "mcp"] }))).toBe(true);
  });

  it("rejects a capability whose surfaces list does not include 'mcp'", () => {
    expect(isMcpTool(makeCap({ surfaces: ["api", "cli"] }))).toBe(false);
  });

  it("rejects an empty surfaces list", () => {
    expect(isMcpTool(makeCap({ surfaces: [] }))).toBe(false);
  });

  it("rejects a humanOnly capability even when surfaces include 'mcp'", () => {
    expect(isMcpTool(makeCap({ surfaces: ["mcp"], humanOnly: true }))).toBe(false);
  });

  it("accepts when humanOnly is explicitly false", () => {
    expect(isMcpTool(makeCap({ surfaces: ["mcp"], humanOnly: false }))).toBe(true);
  });

  it("accepts when humanOnly is undefined (default)", () => {
    expect(isMcpTool(makeCap({ surfaces: ["mcp"] }))).toBe(true);
  });
});
