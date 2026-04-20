import type { Capability } from "@editorzero/capabilities";
import { registerCapability } from "@editorzero/capabilities";
import { CapabilityId } from "@editorzero/ids";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { NonObjectInputSchemaError, toToolConfig } from "./tool-config";

function makeCap<I>(opts: { id?: string; summary?: string; input: z.ZodType<I> }) {
  const id = opts.id ?? "doc.test";
  const typed: Capability<I, Record<string, never>> = {
    id: CapabilityId(id),
    category: "read",
    summary: opts.summary ?? "stub summary",
    input: opts.input,
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
    surfaces: ["mcp"],
    handler: async () => ({}) as Record<string, never>,
  };
  return registerCapability(typed);
}

describe("toToolConfig", () => {
  it("projects a capability's summary onto description", () => {
    const cap = makeCap({
      input: z.object({}).strict(),
      summary: "List docs in the workspace",
    });
    expect(toToolConfig(cap).description).toBe("List docs in the workspace");
  });

  it("projects a ZodObject input's raw shape onto inputSchema", () => {
    const cap = makeCap({
      input: z.object({ doc_id: z.string(), force: z.boolean().optional() }).strict(),
    });
    const config = toToolConfig(cap);
    expect(Object.keys(config.inputSchema).sort()).toEqual(["doc_id", "force"]);
    // biome-ignore lint/complexity/useLiteralKeys: TS4111 — zod raw shape is Record<string, ZodType>, bracket access required
    expect(config.inputSchema["doc_id"]).toBeDefined();
    // biome-ignore lint/complexity/useLiteralKeys: TS4111 — zod raw shape is Record<string, ZodType>, bracket access required
    expect(config.inputSchema["force"]).toBeDefined();
  });

  it("projects an empty ZodObject input as an empty shape", () => {
    const cap = makeCap({ input: z.object({}).strict() });
    expect(toToolConfig(cap).inputSchema).toEqual({});
  });

  it("throws NonObjectInputSchemaError on a non-ZodObject input", () => {
    // Top-level primitives violate the MCP tool-arg shape.
    const cap = makeCap({ id: "bad.prim", input: z.string() as never });
    expect(() => toToolConfig(cap)).toThrow(NonObjectInputSchemaError);
  });

  it("NonObjectInputSchemaError carries the offending capability id", () => {
    const cap = makeCap({ id: "bad.union", input: z.union([z.string(), z.number()]) as never });
    try {
      toToolConfig(cap);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NonObjectInputSchemaError);
      if (err instanceof NonObjectInputSchemaError) {
        expect(err.capability_id).toBe("bad.union");
      }
    }
  });
});
