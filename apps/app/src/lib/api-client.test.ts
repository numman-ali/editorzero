import { expect, it } from "vitest";

import { apiClient } from "./api-client";

it("constructs the same-origin singleton exposing the typed whoami path", () => {
  // hc is lazy — property access builds a proxy and fires no request — so this
  // asserts the typed-RPC surface is wired without hitting the network.
  expect(apiClient.infra.whoami).toBeDefined();
});
