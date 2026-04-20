import { PassThrough } from "node:stream";

import { createRegistry, docCreate, docList, registerCapability } from "@editorzero/capabilities";
import { describe, expect, it, vi } from "vitest";

import type { AuthCredentialStore } from "../credential-store";
import { createRootCommands } from "./root";

function makeStoreFake(): AuthCredentialStore {
  return {
    async read() {
      return { cookie: "session=x" };
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: root tests never invoke store mutations; read stub is sufficient.
    async write() {},
    // biome-ignore lint/suspicious/noEmptyBlockStatements: same.
    async clear() {},
  };
}

function captured(): { stream: PassThrough } {
  const stream = new PassThrough();
  return { stream };
}

describe("createRootCommands", () => {
  it("derives one top-level entry per distinct domain in the registry", () => {
    const { stream } = captured();
    const registry = createRegistry([registerCapability(docList), registerCapability(docCreate)]);
    const roots = createRootCommands(registry, {
      storeFactory: makeStoreFake,
      fetch: vi.fn(),
      stdout: stream,
    });
    expect(Object.keys(roots)).toEqual(["doc"]);
  });

  it("skips capabilities whose surfaces do not include 'cli'", () => {
    const { stream } = captured();
    const listCap = registerCapability(docList);
    // biome-ignore lint/suspicious/noExplicitAny: synthetic UI-only capability in a distinct domain to exercise the filter.
    const uiOnlyBlock: any = {
      ...listCap,
      id: "block.list",
      surfaces: ["ui"],
    };
    const registry = createRegistry([listCap, uiOnlyBlock]);
    const roots = createRootCommands(registry, {
      storeFactory: makeStoreFake,
      fetch: vi.fn(),
      stdout: stream,
    });
    expect(Object.keys(roots)).toEqual(["doc"]);
  });

  it("yields multiple top-level entries when capabilities span domains", () => {
    const { stream } = captured();
    const listCap = registerCapability(docList);
    // biome-ignore lint/suspicious/noExplicitAny: synthetic capability to simulate a second domain; real kernel enforces shape.
    const blockList: any = {
      ...listCap,
      id: "block.list",
      surfaces: ["cli", "api"],
    };
    const registry = createRegistry([listCap, blockList]);
    const roots = createRootCommands(registry, {
      storeFactory: makeStoreFake,
      fetch: vi.fn(),
      stdout: stream,
    });
    expect(Object.keys(roots).sort()).toEqual(["block", "doc"]);
  });
});
