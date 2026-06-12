import { describe, expect, it } from "vitest";

import { API_ERROR_CODES, ApiError, isApiError, isApiErrorCode } from "./api-error";

describe("ApiError", () => {
  it("carries status + code and is a real Error subclass", () => {
    const err = new ApiError(403, "permission_denied");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe("ApiError");
    expect(err.status).toBe(403);
    expect(err.code).toBe("permission_denied");
    expect(err.message).toBe("ApiError 403: permission_denied");
  });

  it("carries a non-typed code verbatim (middleware 401)", () => {
    const err = new ApiError(401, "unauthenticated");
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthenticated");
  });
});

describe("isApiError", () => {
  it("is true only for an ApiError instance", () => {
    expect(isApiError(new ApiError(404, "not_found"))).toBe(true);
    expect(isApiError(new Error("plain"))).toBe(false);
    expect(isApiError("not_found")).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError({ status: 404, code: "not_found" })).toBe(false);
  });
});

describe("isApiErrorCode", () => {
  it("is true for every typed capability code", () => {
    for (const code of API_ERROR_CODES) {
      expect(isApiErrorCode(code)).toBe(true);
    }
  });

  it("is false for non-capability codes (middleware 401, fallback, unknown, empty)", () => {
    expect(isApiErrorCode("unauthenticated")).toBe(false);
    expect(isApiErrorCode("request_failed")).toBe(false);
    expect(isApiErrorCode("internal_error")).toBe(false);
    expect(isApiErrorCode("")).toBe(false);
  });

  it("mirrors exactly the 14 server-side typed codes", () => {
    expect(API_ERROR_CODES).toHaveLength(14);
  });
});
