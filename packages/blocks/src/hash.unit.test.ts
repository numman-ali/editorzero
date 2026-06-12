/**
 * Isomorphic content hash (ADR 0022 §57) — unit tests.
 *
 * The known-vector test pins the digest algorithm itself: the browser
 * (WebCrypto) and any future runtime must keep producing exactly this
 * sha-256-over-canonical-JSON value or every stored
 * `expect_prior_content_hash` silently stops matching.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalize, hashBlockContent, stableHash } from "./hash";

describe("canonicalize", () => {
  it("sorts object keys recursively; arrays keep order", () => {
    expect(JSON.stringify(canonicalize({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("passes primitives and null through", () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize("x")).toBe("x");
    expect(canonicalize(7)).toBe(7);
  });
});

describe("stableHash", () => {
  it("matches node:crypto sha256 over the canonical JSON (known vector)", async () => {
    const input = { type: "paragraph", props: {}, content: [{ text: "x" }] };
    const expected = createHash("sha256")
      .update(JSON.stringify(canonicalize(input)))
      .digest("hex");
    await expect(stableHash(input)).resolves.toBe(expected);
  });

  it("is key-order independent", async () => {
    await expect(stableHash({ a: 1, b: 2 })).resolves.toBe(await stableHash({ b: 2, a: 1 }));
  });

  it("hashes undefined input as the empty string", async () => {
    const expected = createHash("sha256").update("").digest("hex");
    await expect(stableHash(undefined)).resolves.toBe(expected);
  });
});

describe("hashBlockContent", () => {
  it("covers exactly { type, props, content } — id and position are excluded", async () => {
    const base = { type: "paragraph", props: {}, content: [{ text: "x" }] };
    const withExtras = { ...base, id: "b1", order_key: "000003", parent_block_id: null };
    await expect(hashBlockContent(withExtras)).resolves.toBe(await hashBlockContent(base));
  });

  it("changes when content changes", async () => {
    const a = await hashBlockContent({ type: "paragraph", content: "x" });
    const b = await hashBlockContent({ type: "paragraph", content: "y" });
    expect(a).not.toBe(b);
  });
});
