import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { readPasswordFromStdin } from "./prompt-password";

describe("readPasswordFromStdin", () => {
  it("reads the full stdin buffer and returns the utf8 string", async () => {
    const stdin = Readable.from(["hello-world"]);
    expect(await readPasswordFromStdin(stdin)).toBe("hello-world");
  });

  it("strips a trailing \\n (the common `echo $PASS |` idiom)", async () => {
    const stdin = Readable.from(["supersecret\n"]);
    expect(await readPasswordFromStdin(stdin)).toBe("supersecret");
  });

  it("strips a trailing \\r\\n (Windows line endings)", async () => {
    const stdin = Readable.from(["supersecret\r\n"]);
    expect(await readPasswordFromStdin(stdin)).toBe("supersecret");
  });

  it("does not strip internal newlines — only the trailing one", async () => {
    const stdin = Readable.from(["line1\nline2\n"]);
    expect(await readPasswordFromStdin(stdin)).toBe("line1\nline2");
  });

  it("handles multi-chunk streams by concatenating", async () => {
    const stdin = Readable.from(["part1-", "part2-", "part3"]);
    expect(await readPasswordFromStdin(stdin)).toBe("part1-part2-part3");
  });

  it("returns empty string for an empty stream", async () => {
    const stdin = Readable.from([]);
    expect(await readPasswordFromStdin(stdin)).toBe("");
  });

  it("handles Buffer chunks (the real stdin shape)", async () => {
    const stdin = Readable.from([Buffer.from("secret"), Buffer.from("\n")]);
    expect(await readPasswordFromStdin(stdin)).toBe("secret");
  });
});
