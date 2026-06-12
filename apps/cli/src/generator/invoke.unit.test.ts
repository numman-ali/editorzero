import { PassThrough } from "node:stream";

import { docCreate, docGet, docList, registerCapability } from "@editorzero/capabilities";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { AuthCredentialStore, CredentialHeaders } from "../credential-store";
import { runCapability } from "./invoke";

function makeStoreFake(initial: CredentialHeaders | null): AuthCredentialStore & {
  clears: number;
} {
  let current = initial;
  let clears = 0;
  return {
    get clears() {
      return clears;
    },
    async read() {
      return current;
    },
    async write(headers) {
      current = headers;
    },
    async clear() {
      current = null;
      clears += 1;
    },
  };
}

function captured(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

const DOC_ID = "018f0000-0000-7000-8000-0000000000d1";
const WORKSPACE_ID = "018f0000-0000-7000-8000-0000000000b1";

describe("runCapability", () => {
  it("emits auth_expired when no local credential exists (no network call)", async () => {
    const store = makeStoreFake(null);
    const { stream, read } = captured();
    const fetch = vi.fn();

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_expired");
  });

  it("doc.list — GET /docs/list round-trip emits the parsed output + exit 0", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const docsPayload = {
      docs: [
        {
          id: DOC_ID,
          title: "First doc",
          slug: "first-doc",
          collection_id: null,
          access_mode: "space",
          published_slug: null,
          published_at: null,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_000,
        },
      ],
    };
    const fetch = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(JSON.stringify(docsPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/docs/list",
      expect.objectContaining({ method: "GET" }),
    );
    const body = JSON.parse(read()) as { docs: { id: string }[] };
    expect(body.docs[0]?.id).toBe(DOC_ID);
  });

  it("doc.create — POST /docs/create with JSON body", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream } = captured();
    const serverResponse = {
      doc_id: DOC_ID,
      workspace_id: WORKSPACE_ID,
      collection_id: null,
      title: "Hello",
      slug: "hello",
      order_key: "a",
      created_by: "018f0000-0000-7000-8000-000000000002",
      access_mode: "space",
      published_slug: null,
      published_at: null,
      seed_blocks: [],
    };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(serverResponse), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );

    const exit = await runCapability(
      registerCapability(docCreate),
      { baseUrl: "http://localhost:3000", rawArgs: { title: "Hello" } },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call[0]).toBe("http://localhost:3000/docs/create");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ title: "Hello" }));
  });

  it("doc.get — GET /docs/get/:doc_id expands the path param", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream } = captured();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            doc: {
              id: DOC_ID,
              workspace_id: WORKSPACE_ID,
              collection_id: null,
              title: "X",
              slug: "x",
              order_key: "a",
              access_mode: "space",
              published_slug: null,
              published_at: null,
              created_at: 1,
              updated_at: 1,
            },
            blocks: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const exit = await runCapability(
      registerCapability(docGet),
      { baseUrl: "http://localhost:3000", rawArgs: { doc_id: DOC_ID } },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      `http://localhost:3000/docs/get/${DOC_ID}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("emits cli_validation_error on missing required input (no network call)", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn();

    const exit = await runCapability(
      registerCapability(docGet),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    const body = JSON.parse(read()) as {
      error: { code: string; issues: { path: (string | number)[] }[] };
    };
    expect(body.error.code).toBe("cli_validation_error");
    expect(body.error.issues[0]?.path).toEqual(["doc_id"]);
  });

  it("401 response clears the credential + emits auth_expired", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    expect(store.clears).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_expired");
  });

  it("403 response maps to permission_denied with the capability's required scopes", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "permission_denied" }), { status: 403 }),
    );

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as {
      error: { code: string; required_scopes: readonly string[] };
    };
    expect(body.error.code).toBe("permission_denied");
    expect(body.error.required_scopes).toEqual(["doc:read"]);
  });

  it("404 response maps to not_found", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );

    const exit = await runCapability(
      registerCapability(docGet),
      { baseUrl: "http://localhost:3000", rawArgs: { doc_id: DOC_ID } },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("400 response maps to validation with the server body attached", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "validation" }), { status: 400 }),
    );

    const exit = await runCapability(
      registerCapability(docCreate),
      { baseUrl: "http://localhost:3000", rawArgs: { title: "Valid" } },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as {
      error: { code: string; server: { error: string } };
    };
    expect(body.error.code).toBe("validation");
    expect(body.error.server.error).toBe("validation");
  });

  it("5xx responses map to request_failed with the status code", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => new Response("bad gateway", { status: 502 }));

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as {
      error: { code: string; status: number; server: unknown };
    };
    expect(body.error.code).toBe("request_failed");
    expect(body.error.status).toBe(502);
    expect(body.error.server).toBe("bad gateway");
  });

  it("network error → network_error envelope", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("network_error");
    expect(body.error.message).toBe("ECONNREFUSED");
  });

  it("non-Error throw falls through to 'unknown' message", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => {
      throw new Error();
    });

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe("");
  });

  it("non-JSON success body → schema_mismatch", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () =>
        new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("schema_mismatch");
  });

  it("wrong-shape JSON body → schema_mismatch", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ wrong: "shape" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string } };
    expect(body.error.code).toBe("schema_mismatch");
  });

  it("error body that fails JSON.parse falls through to text()", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream, read } = captured();
    const fetch = vi.fn(async () => new Response("unparseable-plain-text", { status: 500 }));

    const exit = await runCapability(
      registerCapability(docList),
      { baseUrl: "http://localhost:3000", rawArgs: {} },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(1);
    const body = JSON.parse(read()) as { error: { code: string; server: unknown } };
    expect(body.error.code).toBe("request_failed");
    expect(body.error.server).toBe("unparseable-plain-text");
  });

  // ── Synthetic GET+query coverage (Codex review) ────────────────────────
  // No real doc capability has a GET with non-path-param input — so the
  // `buildUrl` query-string branch only lights up under a synthetic
  // capability here. Lets the parity test earn its keep and keeps the
  // buildUrl branch covered so the first real query-param read capability
  // lands without a coverage drop.

  it("synthetic GET capability with query fields builds a query string", async () => {
    const store = makeStoreFake({ cookie: "session=x" });
    const { stream } = captured();
    const payload = { ok: true };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: synthetic capability stub — only exercises buildUrl/query branches.
    const synthetic: any = {
      id: "thing.search",
      category: "read",
      summary: "",
      input: z
        .object({
          q: z.string(),
          limit: z.string().optional(),
        })
        .strict(),
      output: z.object({ ok: z.boolean() }),
      requires: [],
      surfaces: ["cli"],
      audit: {
        subjectFrom: () => ({ kind: "workspace" }),
        effectOnAllow: () => ({ kind: "audit.access_log" }),
        effectOnDeny: () => ({}),
        effectOnError: () => ({}),
        collapsePolicy: { collapsible: false },
      },
      invoke: async () => payload,
    };

    const exit = await runCapability(
      synthetic,
      { baseUrl: "http://localhost:3000", rawArgs: { q: "hello world", limit: "10" } },
      { store, fetch, stdout: stream },
    );

    expect(exit).toBe(0);
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const url = call[0] as string;
    expect(url).toContain("/things/search?");
    expect(url).toContain("limit=10");
    expect(url).toContain("q=hello+world");
  });
});
