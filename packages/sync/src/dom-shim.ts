/**
 * `ensureDomGlobals` — idempotent happy-dom global registration for
 * the api-server runtime (architecture.md §6.5 + ADR 0018 gotcha).
 *
 * **Why.** Content-mutation capabilities that open a live
 * `BlockNoteEditor` via `withLiveEditor` need `document`, `window`, and
 * the EditorView-adjacent DOM globals available on `globalThis`
 * (ProseMirror's `view.dispatch` path constructs `HTMLElement`s at
 * runtime — without the shim it throws `ReferenceError: document is
 * not defined` deep inside BlockNote's collab plugin).
 *
 * **Single registration.** happy-dom's `GlobalRegistrator.register()`
 * mutates `globalThis` — running it twice isn't documented as safe
 * and would double-install listeners on `process` in some versions.
 * The `typeof globalThis.document` guard keeps this idempotent: tests
 * that already have happy-dom installed via
 * `@vitest-environment happy-dom` see the early return, and the
 * api-server composition root can call this unconditionally at boot.
 *
 * **Preserve Node's fetch suite.** `GlobalRegistrator.register()`
 * swaps `globalThis.fetch` / `Request` / `Response` / `Headers` /
 * `URL` / `URLSearchParams` for happy-dom's browser-style
 * implementations. Those don't round-trip `Set-Cookie` headers the
 * way Better Auth expects (empirically: session-cookie length drops
 * to 0 after `/auth/sign-in/email` and every subsequent request 401s).
 * The save/restore dance below keeps the DOM globals we actually need
 * (`document`, `window`, `HTMLElement`, `MutationObserver`, etc.) and
 * leaves Node's undici-backed fetch-suite intact. A happy-dom bump
 * that ships a non-invasive selective registrar would let us drop this.
 *
 * **Where callers are.** `createApiApp` in `@editorzero/api-server`
 * calls this whenever a dispatcher is wired (the shape where
 * capability handlers actually run). `withLiveEditor` calls it as a
 * defensive second check so a test that constructs the helper
 * directly (without going through api-server) still gets the globals.
 *
 * **Not in the zero-arg path.** `createApiApp()` without a dispatcher
 * is a typed-RPC binding shape only — it never invokes a capability
 * handler, so it doesn't need the globals. Keeping the registration
 * conditional means `@editorzero/api-client` consumers (who import
 * `app` for `hc<AppType>` typing) don't pay a surprise module-load
 * side effect.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function ensureDomGlobals(): void {
  if (typeof globalThis.document !== "undefined") return;

  // Snapshot Node's fetch-suite + AbortController BEFORE happy-dom
  // overwrites them. Under Node 22 LTS these are undici-backed
  // implementations that Better Auth's handler chain + the MCP SDK's
  // StreamableHTTPClientTransport depend on. Mixing happy-dom's
  // `AbortSignal` with undici's `Request` throws at construction
  // ("RequestInit: Expected signal to be an instance of AbortSignal").
  const nodeFetch = globalThis.fetch;
  const nodeRequest = globalThis.Request;
  const nodeResponse = globalThis.Response;
  const nodeHeaders = globalThis.Headers;
  const nodeFormData = globalThis.FormData;
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

  GlobalRegistrator.register();

  // Restore Node's fetch-suite + AbortController. happy-dom installed
  // `document` / `window` / DOM globals which we keep; the fetch +
  // abort machinery returns to Node's implementation.
  globalThis.fetch = nodeFetch;
  globalThis.Request = nodeRequest;
  globalThis.Response = nodeResponse;
  globalThis.Headers = nodeHeaders;
  globalThis.FormData = nodeFormData;
  globalThis.URL = nodeURL;
  globalThis.URLSearchParams = nodeURLSearchParams;
  globalThis.AbortController = nodeAbortController;
  globalThis.AbortSignal = nodeAbortSignal;
  globalThis.crypto = nodeCrypto;
  globalThis.ReadableStream = nodeReadableStream;
  globalThis.WritableStream = nodeWritableStream;
  globalThis.TransformStream = nodeTransformStream;
  globalThis.TextEncoder = nodeTextEncoder;
  globalThis.TextDecoder = nodeTextDecoder;
  globalThis.Blob = nodeBlob;
  globalThis.File = nodeFile;
}
