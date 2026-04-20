import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { emit, emitError, isAgentMode } from "./io";

function captured(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

describe("emit / emitError", () => {
  it("emit writes a single JSON line terminated with \\n", () => {
    const { stream, read } = captured();
    emit({ hello: "world" }, stream);
    expect(read()).toBe(`{"hello":"world"}\n`);
  });

  it("emit handles primitives and arrays", () => {
    const { stream, read } = captured();
    emit([1, 2, 3], stream);
    expect(read()).toBe("[1,2,3]\n");
  });

  it("emitError writes the AXI envelope with code + help", () => {
    const { stream, read } = captured();
    emitError("auth_expired", "Run ez auth login.", {}, stream);
    expect(read()).toBe(`{"error":{"code":"auth_expired","help":"Run ez auth login."}}\n`);
  });

  it("emitError merges extras into the error envelope", () => {
    const { stream, read } = captured();
    emitError("auth_failed", "Check creds.", { status: 401 }, stream);
    const parsed = JSON.parse(read()) as { error: { code: string; help: string; status: number } };
    expect(parsed.error).toEqual({
      code: "auth_failed",
      help: "Check creds.",
      status: 401,
    });
  });

  it("emitError falls back to an empty extras object when not provided", () => {
    const { stream, read } = captured();
    emitError("x", "y", undefined, stream);
    expect(read()).toBe(`{"error":{"code":"x","help":"y"}}\n`);
  });
});

describe("isAgentMode", () => {
  it("returns true when stdout.isTTY is false", () => {
    expect(isAgentMode({ isTTY: false } as NodeJS.WriteStream)).toBe(true);
  });

  it("returns false when stdout.isTTY is true", () => {
    expect(isAgentMode({ isTTY: true } as NodeJS.WriteStream)).toBe(false);
  });

  it("returns true when stdout.isTTY is undefined (piped stream with no tty info)", () => {
    expect(isAgentMode({} as NodeJS.WriteStream)).toBe(true);
  });
});
