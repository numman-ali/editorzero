import { describe, expect, it } from "vitest";

import { ConfigValidationError, parseRuntimeConfig } from "./env";

/**
 * `parseRuntimeConfig` — the env→typed-config boundary. These pin the
 * behaviours a misconfiguration would otherwise surface only at first
 * request: a missing required field is a hard boot failure, and the
 * `rate_limit_disabled` opt-out carries the same presence-enables footgun
 * as every other `z.coerce.boolean()` flag here (so it gets pinned where a
 * future reader can see it).
 */

/** The two hard-required fields; everything else has a schema default. */
const MINIMAL = {
  EDITORZERO_PUBLIC_ORIGIN: "https://editor.example",
  DATABASE_URL: "/tmp/e2e.sqlite",
} as const;

describe("parseRuntimeConfig — required fields", () => {
  it("throws ConfigValidationError listing every missing/invalid key", () => {
    // Neither required field present, and a bad enum on a defaulted one.
    expect(() => parseRuntimeConfig({ EDITORZERO_MODE: "nonsense" })).toThrow(
      ConfigValidationError,
    );
  });

  it("parses a minimal env, applying schema defaults", () => {
    const config = parseRuntimeConfig({ ...MINIMAL });
    expect(config.public_origin).toBe("https://editor.example");
    expect(config.mode).toBe("single-node");
    expect(config.node_env).toBe("development");
    expect(config.port).toBe(3000);
  });
});

describe("parseRuntimeConfig — rate_limit_disabled", () => {
  it("defaults to false — limiting is ON unless explicitly opted out", () => {
    expect(parseRuntimeConfig({ ...MINIMAL }).rate_limit_disabled).toBe(false);
  });

  it("any non-empty value disables (presence-enables, the z.coerce.boolean idiom)", () => {
    expect(
      parseRuntimeConfig({ ...MINIMAL, EDITORZERO_RATE_LIMIT_DISABLED: "1" }).rate_limit_disabled,
    ).toBe(true);
  });

  it("FOOTGUN: '=false' STILL disables — z.coerce.boolean reads any non-empty string as true", () => {
    // Documented on purpose: to RE-ENABLE limiting you UNSET the var, you do
    // not set it to "false"/"0". `Boolean("false") === true`.
    expect(
      parseRuntimeConfig({ ...MINIMAL, EDITORZERO_RATE_LIMIT_DISABLED: "false" })
        .rate_limit_disabled,
    ).toBe(true);
  });

  it("an empty string coerces to false — Boolean('') === false (so limiting stays ON)", () => {
    // An empty value is still "provided", so this is coercion, not the
    // default path — but it lands on the same safe answer.
    expect(
      parseRuntimeConfig({ ...MINIMAL, EDITORZERO_RATE_LIMIT_DISABLED: "" }).rate_limit_disabled,
    ).toBe(false);
  });
});
