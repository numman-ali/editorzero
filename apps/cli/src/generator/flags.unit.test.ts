import { describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveFlags, deriveJsonFlagKeys } from "./flags";

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

  it("marks ZodDefault fields as non-required (a default backfills an omitted flag)", () => {
    // Regression: `agent.token_mint`'s `expires_at` is
    // `z.coerce.number().nullable().default(null)` — a ZodDefault, NOT a
    // ZodOptional. Before the fix the CLI forced `--expires_at` on every
    // mint; the e2e dogfood surfaced it.
    expect(
      deriveFlags(
        z.object({
          tier: z.string(),
          expires_at: z.coerce.number().nullable().default(null),
        }),
      ),
    ).toEqual({
      tier: { type: "string", required: true },
      expires_at: { type: "string", required: false },
    });
  });

  it("keeps a bare ZodNullable field required (null is a value, not an omission)", () => {
    expect(
      deriveFlags(
        z.object({
          parent_id: z.string().nullable(),
        }),
      ),
    ).toEqual({
      parent_id: { type: "string", required: true },
    });
  });

  it("rejects non-ZodObject schemas", () => {
    expect(() => deriveFlags(z.string())).toThrow(/not a ZodObject \(typeName=ZodString\)/);
  });
});

describe("deriveJsonFlagKeys", () => {
  it("returns the empty set when no field is structured", () => {
    expect(
      deriveJsonFlagKeys(
        z.object({
          doc_id: z.string(),
          page_size: z.coerce.number().optional(),
        }),
      ),
    ).toEqual(new Set());
  });

  it("marks object / discriminated-union / array fields (through optional + nullable)", () => {
    expect(
      deriveJsonFlagKeys(
        z.object({
          title: z.string(),
          destination: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("legacy_root") }).strict(),
            z.object({ kind: z.literal("collection"), collection_id: z.string() }).strict(),
          ]),
          filters: z.object({ q: z.string() }).optional(),
          tags: z.array(z.string()).nullable().optional(),
        }),
      ),
    ).toEqual(new Set(["destination", "filters", "tags"]));
  });

  it("does NOT mark string-input transform pipelines (branded ids stay plain flags)", () => {
    expect(
      deriveJsonFlagKeys(
        z.object({
          collection_id: z
            .string()
            .uuid()
            .transform((v) => v),
        }),
      ),
    ).toEqual(new Set());
  });

  it("rejects non-ZodObject schemas", () => {
    expect(() => deriveJsonFlagKeys(z.string())).toThrow(/not a ZodObject \(typeName=ZodString\)/);
  });
});
