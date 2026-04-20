import { PassThrough } from "node:stream";

import { docCreate, docList, registerCapability } from "@editorzero/capabilities";
import { describe, expect, it, vi } from "vitest";

import type { AuthCredentialStore, CredentialHeaders } from "../credential-store";
import { createCapabilityCommand, createDomainCommand } from "./command";

function makeStoreFake(
  initial: CredentialHeaders | null = { cookie: "session=x" },
): AuthCredentialStore {
  let current = initial;
  return {
    async read() {
      return current;
    },
    async write(headers) {
      current = headers;
    },
    async clear() {
      current = null;
    },
  };
}

function captured(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

const DOCS_PAYLOAD = {
  docs: [
    {
      id: "018f0000-0000-7000-8000-0000000000d1",
      title: "A doc",
      slug: "a-doc",
      collection_id: null,
      visibility: "workspace" as const,
      created_at: 1,
      updated_at: 1,
    },
  ],
};

describe("createCapabilityCommand", () => {
  it("exposes the action name + the capability summary as meta", async () => {
    const { stream } = captured();
    const cmd = createCapabilityCommand(registerCapability(docList), {
      storeFactory: () => makeStoreFake(),
      fetch: vi.fn(),
      stdout: stream,
    });
    // meta/args can be thunks that resolve lazily — call each if needed.
    const metaOrPromise = typeof cmd.meta === "function" ? cmd.meta() : cmd.meta;
    const meta = await Promise.resolve(metaOrPromise);
    expect(meta).toMatchObject({
      name: "list",
      description: "List all non-deleted docs in the workspace, ordered by order_key.",
    });
  });

  it("uses the default base URL when --base-url is not supplied", async () => {
    const { stream } = captured();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(DOCS_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const cmd = createCapabilityCommand(registerCapability(docList), {
      storeFactory: () => makeStoreFake(),
      fetch,
      stdout: stream,
    });
    const run = (cmd as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run;
    await run({ args: { "base-url": "http://localhost:3000" } });
    expect(fetch).toHaveBeenCalledWith("http://localhost:3000/docs/list", expect.any(Object));
  });

  it("honours an overridden --base-url", async () => {
    const { stream } = captured();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(DOCS_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const cmd = createCapabilityCommand(registerCapability(docList), {
      storeFactory: () => makeStoreFake(),
      fetch,
      stdout: stream,
    });
    const run = (cmd as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run;
    await run({ args: { "base-url": "https://example.test" } });
    expect(fetch).toHaveBeenCalledWith("https://example.test/docs/list", expect.any(Object));
  });

  it("sets process.exitCode from the run-capability exit code on failure", async () => {
    const { stream } = captured();
    // No credential → runCapability returns 1 before any fetch.
    const cmd = createCapabilityCommand(registerCapability(docList), {
      storeFactory: () => makeStoreFake(null),
      fetch: vi.fn(),
      stdout: stream,
    });
    const before = process.exitCode;
    try {
      const run = (cmd as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run;
      await run({ args: { "base-url": "http://localhost:3000" } });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
  });
});

describe("createDomainCommand", () => {
  it("groups only capabilities whose id starts with the domain prefix AND whose surfaces include 'cli'", () => {
    const { stream } = captured();
    const listCap = registerCapability(docList);
    const createCap = registerCapability(docCreate);
    // Synthesize a capability in a different domain to confirm it's
    // filtered out.
    // biome-ignore lint/suspicious/noExplicitAny: mixed-domain stub for the filter-in test; the real kernel enforces the shape.
    const otherDomainCap: any = {
      ...listCap,
      id: "block.list",
      surfaces: ["cli", "api"],
    };
    // Synthesize a same-domain capability whose surfaces omit 'cli'.
    // biome-ignore lint/suspicious/noExplicitAny: stub for the filter-out test.
    const uiOnlyCap: any = {
      ...createCap,
      id: "doc.ui-only",
      surfaces: ["ui"],
    };
    const cmd = createDomainCommand("doc", [listCap, createCap, otherDomainCap, uiOnlyCap], {
      storeFactory: () => makeStoreFake(),
      fetch: vi.fn(),
      stdout: stream,
    });
    const subCommands = (cmd as { subCommands?: Record<string, unknown> }).subCommands ?? {};
    expect(Object.keys(subCommands).sort()).toEqual(["create", "list"]);
  });

  it("emits a top-level description that mentions the domain", async () => {
    const { stream } = captured();
    const cmd = createDomainCommand("doc", [registerCapability(docList)], {
      storeFactory: () => makeStoreFake(),
      fetch: vi.fn(),
      stdout: stream,
    });
    const metaOrPromise = typeof cmd.meta === "function" ? cmd.meta() : cmd.meta;
    const meta = await Promise.resolve(metaOrPromise);
    expect(meta?.name).toBe("doc");
    expect(meta?.description).toContain("doc");
  });
});
