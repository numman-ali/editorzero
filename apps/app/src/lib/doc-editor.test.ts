import { type ApiClient, ApiError, createHttpClient } from "@editorzero/api-client";
import type { Block } from "@editorzero/blocks";
import { describe, expect, it } from "vitest";

import {
  buildSaveOps,
  classifySaveError,
  docQueryKey,
  docQueryOptions,
  fetchDoc,
  saveDoc,
  saveFailureMessage,
} from "./doc-editor";

/** Same fake-client pattern as docs.test.ts / session.test.ts. */
function clientReturning(
  status: number,
  body: unknown,
  capture?: { url?: string; payload?: unknown },
): ApiClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    if (capture !== undefined) {
      capture.url = String(input);
      if (typeof init?.body === "string") {
        capture.payload = JSON.parse(init.body);
      }
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return createHttpClient({ baseUrl: "http://test.local", fetch: fetchImpl });
}

const DOC_ID = "018f0000-0000-7000-8000-0000000000d1";
const BLOCK_H = "018f0000-0000-7000-8000-0000000000b1";
const BLOCK_P = "018f0000-0000-7000-8000-0000000000b2";

const DOC_BODY = {
  doc: {
    id: DOC_ID,
    workspace_id: "018f0000-0000-7000-8000-000000000001",
    title: "Hello",
    slug: "hello",
    collection_id: null,
    visibility: "workspace",
    created_at: 1,
    updated_at: 2,
  },
  blocks: [
    {
      id: BLOCK_H,
      type: "heading",
      props: { level: 1 },
      content: [{ type: "text", text: "Hello", styles: {} }],
      children: [],
    },
    {
      id: BLOCK_P,
      type: "paragraph",
      props: {},
      content: [],
      children: [],
    },
  ],
};

function baseBlocks(): Block[] {
  return [
    {
      id: BLOCK_H,
      type: "heading",
      props: { level: 1 },
      content: [{ type: "text", text: "Hello", styles: {} }],
      children: [],
    },
    { id: BLOCK_P, type: "paragraph", props: {}, content: [], children: [] },
  ];
}

describe("fetchDoc", () => {
  it("resolves doc metadata + parsed canonical blocks on 200", async () => {
    const capture: { url?: string } = {};
    const data = await fetchDoc(DOC_ID, clientReturning(200, DOC_BODY, capture));
    expect(capture.url).toBe(`http://test.local/docs/get/${DOC_ID}`);
    expect(data.doc.title).toBe("Hello");
    expect(data.blocks).toEqual(baseBlocks());
  });

  it("throws a typed ApiError on the error arms", async () => {
    await expect(
      fetchDoc(DOC_ID, clientReturning(404, { error: "not_found" })),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(
      fetchDoc(DOC_ID, clientReturning(401, { error: "unauthenticated" })),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("throws loud when the wire blocks fail the owned-model parse", async () => {
    const corrupted = { ...DOC_BODY, blocks: [{ id: "x", type: "paragraph" }] };
    await expect(fetchDoc(DOC_ID, clientReturning(200, corrupted))).rejects.toThrow();
  });
});

describe("docQueryOptions", () => {
  it("keys the cache per doc id", () => {
    expect(docQueryOptions(DOC_ID).queryKey).toEqual(docQueryKey(DOC_ID));
    expect(docQueryKey("a")).not.toEqual(docQueryKey("b"));
  });
});

describe("buildSaveOps", () => {
  it("returns [] when nothing changed", async () => {
    await expect(buildSaveOps(baseBlocks(), baseBlocks())).resolves.toEqual([]);
  });

  it("stamps the base block's content hash on updates", async () => {
    const current = baseBlocks().map((block, index) =>
      index === 1
        ? { ...block, content: [{ type: "text" as const, text: "edited", styles: {} }] }
        : block,
    );
    const ops = await buildSaveOps(baseBlocks(), current);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (op?.op !== "update") throw new Error("expected update");
    expect(op.block_id).toBe(BLOCK_P);
    expect(op.expect_prior_content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emits an insert (no hash) for an unminted editor block", async () => {
    const current = [
      ...baseBlocks(),
      { id: "", type: "paragraph", props: {}, content: [], children: [] },
    ];
    const ops = await buildSaveOps(baseBlocks(), current);
    expect(ops).toEqual([{ op: "insert", block: { type: "paragraph" }, after_block_id: BLOCK_P }]);
  });
});

describe("saveDoc", () => {
  it("POSTs the ops to the doc.update route and resolves on 200", async () => {
    const capture: { url?: string; payload?: unknown } = {};
    const ops = await buildSaveOps(baseBlocks(), [
      ...baseBlocks(),
      { id: "", type: "paragraph", props: {}, content: [], children: [] },
    ]);
    await saveDoc(
      DOC_ID,
      ops,
      clientReturning(200, { doc_id: DOC_ID, applied_ops: [], updated_at: 3 }, capture),
    );
    expect(capture.url).toBe(`http://test.local/docs/update/${DOC_ID}`);
    expect(capture.payload).toEqual({ ops });
  });

  it("throws the typed envelope on failure", async () => {
    await expect(
      saveDoc(
        DOC_ID,
        [{ op: "remove", block_id: BLOCK_P }],
        clientReturning(409, { error: "stale_precondition" }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "stale_precondition" });
  });
});

describe("save failure policy", () => {
  it("classifies a 409 as conflict, everything else as save_failed", () => {
    expect(classifySaveError(new ApiError(409, "stale_precondition"))).toBe("conflict");
    expect(classifySaveError(new ApiError(500, "internal"))).toBe("save_failed");
    expect(classifySaveError(new TypeError("network down"))).toBe("save_failed");
  });

  it("gives the conflict arm reload guidance and the generic arm retry guidance", () => {
    expect(saveFailureMessage("conflict")).toMatch(/Reload/);
    expect(saveFailureMessage("save_failed")).toMatch(/try again/i);
  });
});
