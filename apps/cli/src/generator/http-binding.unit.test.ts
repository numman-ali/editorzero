import {
  docCreate,
  docDelete,
  docGet,
  docList,
  docPublish,
  docRename,
  docRestore,
  docUnpublish,
  registerCapability,
} from "@editorzero/capabilities";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveHttpBinding, expandPathTemplate } from "./http-binding";

describe("deriveHttpBinding", () => {
  it("doc.list → GET /docs/list with no param / no body", () => {
    const binding = deriveHttpBinding(registerCapability(docList));
    expect(binding).toEqual({
      verb: "GET",
      pathTemplate: "/docs/list",
      paramName: null,
      bodyOrQueryKeys: [],
    });
  });

  it("doc.create → POST /docs/create with body keys (no path param)", () => {
    const binding = deriveHttpBinding(registerCapability(docCreate));
    expect(binding).toEqual({
      verb: "POST",
      pathTemplate: "/docs/create",
      paramName: null,
      bodyOrQueryKeys: ["title"],
    });
  });

  it("doc.get → GET /docs/get/:doc_id with path param, no body", () => {
    const binding = deriveHttpBinding(registerCapability(docGet));
    expect(binding).toEqual({
      verb: "GET",
      pathTemplate: "/docs/get/:doc_id",
      paramName: "doc_id",
      bodyOrQueryKeys: [],
    });
  });

  it("doc.publish → POST /docs/publish/:doc_id", () => {
    expect(deriveHttpBinding(registerCapability(docPublish))).toEqual({
      verb: "POST",
      pathTemplate: "/docs/publish/:doc_id",
      paramName: "doc_id",
      bodyOrQueryKeys: [],
    });
  });

  it("doc.unpublish → POST /docs/unpublish/:doc_id", () => {
    expect(deriveHttpBinding(registerCapability(docUnpublish))).toEqual({
      verb: "POST",
      pathTemplate: "/docs/unpublish/:doc_id",
      paramName: "doc_id",
      bodyOrQueryKeys: [],
    });
  });

  it("doc.delete → POST /docs/delete/:doc_id", () => {
    expect(deriveHttpBinding(registerCapability(docDelete))).toEqual({
      verb: "POST",
      pathTemplate: "/docs/delete/:doc_id",
      paramName: "doc_id",
      bodyOrQueryKeys: [],
    });
  });

  it("doc.restore → POST /docs/restore/:doc_id", () => {
    expect(deriveHttpBinding(registerCapability(docRestore))).toEqual({
      verb: "POST",
      pathTemplate: "/docs/restore/:doc_id",
      paramName: "doc_id",
      bodyOrQueryKeys: [],
    });
  });

  it("doc.rename → POST /docs/rename/:doc_id with body={title}", () => {
    // `doc.rename`'s input carries both `doc_id` (the path param) and
    // `title` (the body). The derivation removes `doc_id` from the
    // body-keys list because `hasParam` matched it.
    expect(deriveHttpBinding(registerCapability(docRename))).toEqual({
      verb: "POST",
      pathTemplate: "/docs/rename/:doc_id",
      paramName: "doc_id",
      bodyOrQueryKeys: ["title"],
    });
  });

  it("rejects capability ids that don't match <domain>.<action>", () => {
    // A synthetic capability with a bad id — we don't have one in the
    // real registry, so mint a stub and assert the throw path.
    const badId = {
      id: "doc.delete.soft",
      category: "read",
      summary: "",
      input: z.object({}).strict(),
      output: z.object({}).strict(),
      requires: [],
      surfaces: ["cli"],
      audit: {
        subjectFrom: () => ({ kind: "workspace" as const }),
        effectOnAllow: () => ({ kind: "audit.access_log" as const }),
        effectOnDeny: () => ({
          kind: "deny" as const,
          capability: "doc.delete.soft",
          required_scopes: [],
          reason_code: "missing_scope" as const,
        }),
        effectOnError: () => ({
          kind: "error" as const,
          capability: "doc.delete.soft",
          error_kind: "unknown" as const,
          code: "unknown",
        }),
        collapsePolicy: { collapsible: false as const },
      },
      // biome-ignore lint/suspicious/noExplicitAny: synthetic capability for the rejection path — the real type guard lives in the kernel.
    } as any;
    expect(() => deriveHttpBinding(badId)).toThrow(/does not match the "<domain>.<action>" shape/);
  });

  it("rejects non-ZodObject input schemas with an informative error", () => {
    const weirdInput = {
      id: "doc.weird",
      category: "read",
      summary: "",
      input: z.string(),
      output: z.object({}).strict(),
      requires: [],
      surfaces: ["cli"],
      audit: {},
      // biome-ignore lint/suspicious/noExplicitAny: synthetic capability for the rejection path.
    } as any;
    expect(() => deriveHttpBinding(weirdInput)).toThrow(/not a ZodObject \(typeName=ZodString\)/);
  });
});

describe("expandPathTemplate", () => {
  it("returns the template unchanged when paramName is null", () => {
    expect(expandPathTemplate("/docs/list", null, null)).toBe("/docs/list");
  });

  it("substitutes the :name placeholder with the supplied value", () => {
    expect(
      expandPathTemplate("/docs/get/:doc_id", "doc_id", "018f0000-0000-7000-8000-0000000000d1"),
    ).toBe("/docs/get/018f0000-0000-7000-8000-0000000000d1");
  });

  it("url-encodes the param value so path-special chars don't escape the segment", () => {
    expect(expandPathTemplate("/docs/get/:doc_id", "doc_id", "a/b?c")).toBe("/docs/get/a%2Fb%3Fc");
  });

  it("throws when a param is expected but no value is supplied", () => {
    expect(() => expandPathTemplate("/docs/get/:doc_id", "doc_id", null)).toThrow(
      /needs a value for :doc_id/,
    );
    expect(() => expandPathTemplate("/docs/get/:doc_id", "doc_id", "")).toThrow(
      /needs a value for :doc_id/,
    );
  });
});
