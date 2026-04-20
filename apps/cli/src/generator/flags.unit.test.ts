import { describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveFlags } from "./flags";

describe("deriveFlags", () => {
  it("returns an empty ArgsDef for an empty-object schema", () => {
    expect(deriveFlags(z.object({}).strict())).toEqual({});
  });

  it("emits a required string flag per top-level field", () => {
    expect(
      deriveFlags(
        z.object({
          title: z.string(),
          slug: z.string(),
        }),
      ),
    ).toEqual({
      title: { type: "string", required: true },
      slug: { type: "string", required: true },
    });
  });

  it("marks ZodOptional fields as non-required", () => {
    expect(
      deriveFlags(
        z.object({
          doc_id: z.string(),
          page_size: z.number().optional(),
        }),
      ),
    ).toEqual({
      doc_id: { type: "string", required: true },
      page_size: { type: "string", required: false },
    });
  });

  it("rejects non-ZodObject schemas", () => {
    expect(() => deriveFlags(z.string())).toThrow(/not a ZodObject \(typeName=ZodString\)/);
  });
});
