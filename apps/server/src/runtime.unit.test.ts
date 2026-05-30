import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { portOf } from "./runtime";

describe("portOf", () => {
  it("returns the port from an AddressInfo", () => {
    const address: AddressInfo = { address: "::", family: "IPv6", port: 4321 };
    expect(portOf(address, 0)).toBe(4321);
  });

  it("falls back to the requested port when not listening (null)", () => {
    expect(portOf(null, 8080)).toBe(8080);
  });

  it("falls back to the requested port for an IPC pipe address (string)", () => {
    expect(portOf("/tmp/editorzero.sock", 8080)).toBe(8080);
  });
});
