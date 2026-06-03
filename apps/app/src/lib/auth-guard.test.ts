import { ApiError } from "@editorzero/api-client";
import { describe, expect, it } from "vitest";

import { isLoginRequired } from "./auth-guard";

describe("isLoginRequired", () => {
  it("is true for a 401 ApiError (the unauthenticated arm → redirect to /login)", () => {
    expect(isLoginRequired(new ApiError(401, "unauthenticated"))).toBe(true);
  });

  it("is false for a 403 ApiError (permission_denied must surface, not redirect)", () => {
    expect(isLoginRequired(new ApiError(403, "permission_denied"))).toBe(false);
  });

  it("is false for a 5xx ApiError (server failure must surface)", () => {
    expect(isLoginRequired(new ApiError(500, "upstream_error"))).toBe(false);
  });

  it("is false for a non-ApiError throwable (network/parse error)", () => {
    expect(isLoginRequired(new Error("network down"))).toBe(false);
  });

  it("is false for non-error values", () => {
    expect(isLoginRequired(null)).toBe(false);
    expect(isLoginRequired("401")).toBe(false);
    expect(isLoginRequired(undefined)).toBe(false);
  });
});
