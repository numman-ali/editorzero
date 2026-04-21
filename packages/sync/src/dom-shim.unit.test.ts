/**
 * `ensureDomGlobals` — unit test.
 *
 * Runs under the Node env (no `@vitest-environment` directive) so
 * `document` starts undefined and the happy-dom register path executes.
 * The `blocknote.integration.test.ts` smoke — which runs under
 * `happy-dom` env — exercises the idempotent early-return path.
 *
 * Vitest's default `isolate: true` spawns a fresh worker per test
 * file, so the DOM globals this installs don't leak into other files.
 */

import { describe, expect, it } from "vitest";

import { ensureDomGlobals } from "./dom-shim";

describe("ensureDomGlobals", () => {
  it("installs `document`/`window` and preserves Node's fetch-suite + crypto + streams", () => {
    // Sanity: baseline Node env has no `document`.
    expect(typeof globalThis.document).toBe("undefined");

    // Snapshot Node's fetch-suite + machinery that happy-dom would
    // otherwise overwrite. Identity-compare post-call to verify the
    // save/restore dance in `ensureDomGlobals` preserves them.
    const nodeFetch = globalThis.fetch;
    const nodeResponse = globalThis.Response;
    const nodeRequest = globalThis.Request;
    const nodeHeaders = globalThis.Headers;
    const nodeURL = globalThis.URL;
    const nodeURLSearchParams = globalThis.URLSearchParams;
    const nodeAbortController = globalThis.AbortController;
    const nodeAbortSignal = globalThis.AbortSignal;
    const nodeCrypto = globalThis.crypto;
    const nodeReadableStream = globalThis.ReadableStream;
    const nodeWritableStream = globalThis.WritableStream;
    const nodeTransformStream = globalThis.TransformStream;
    const nodeTextEncoder = globalThis.TextEncoder;
    const nodeTextDecoder = globalThis.TextDecoder;
    const nodeBlob = globalThis.Blob;
    const nodeFile = globalThis.File;

    ensureDomGlobals();

    // DOM globals now present — happy-dom installed.
    expect(typeof globalThis.document).toBe("object");
    expect(typeof globalThis.window).toBe("object");
    // `document.createElement` is the call site `withLiveEditor`
    // makes — a happy-dom document exposes it.
    expect(typeof globalThis.document.createElement).toBe("function");

    // Fetch-suite preserved by identity. happy-dom's `register()` would
    // have swapped these for browser-style impls that break Better Auth's
    // cookie round-trip + the MCP SDK's `AbortSignal` contract.
    expect(globalThis.fetch).toBe(nodeFetch);
    expect(globalThis.Response).toBe(nodeResponse);
    expect(globalThis.Request).toBe(nodeRequest);
    expect(globalThis.Headers).toBe(nodeHeaders);
    expect(globalThis.URL).toBe(nodeURL);
    expect(globalThis.URLSearchParams).toBe(nodeURLSearchParams);
    expect(globalThis.AbortController).toBe(nodeAbortController);
    expect(globalThis.AbortSignal).toBe(nodeAbortSignal);
    expect(globalThis.crypto).toBe(nodeCrypto);
    expect(globalThis.ReadableStream).toBe(nodeReadableStream);
    expect(globalThis.WritableStream).toBe(nodeWritableStream);
    expect(globalThis.TransformStream).toBe(nodeTransformStream);
    expect(globalThis.TextEncoder).toBe(nodeTextEncoder);
    expect(globalThis.TextDecoder).toBe(nodeTextDecoder);
    expect(globalThis.Blob).toBe(nodeBlob);
    expect(globalThis.File).toBe(nodeFile);
  });

  it("is idempotent — a second call returns early without re-registering", () => {
    // `document` is still set from the previous test's install.
    expect(typeof globalThis.document).toBe("object");
    const firstDocument = globalThis.document;

    ensureDomGlobals();

    // Same document identity — re-register would have replaced it.
    expect(globalThis.document).toBe(firstDocument);
  });
});
