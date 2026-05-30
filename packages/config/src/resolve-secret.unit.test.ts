import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveSecretRef, SecretResolutionError } from "./resolve-secret";

const ENV_VAR = "EDITORZERO_TEST_SECRET_RESOLVE";

describe("resolveSecretRef — env mount", () => {
  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it("returns the env var value", async () => {
    process.env[ENV_VAR] = "shhh-from-env";
    expect(await resolveSecretRef({ mount: "env", env_var: ENV_VAR })).toBe("shhh-from-env");
  });

  it("throws when the env var is unset", async () => {
    await expect(resolveSecretRef({ mount: "env", env_var: ENV_VAR })).rejects.toBeInstanceOf(
      SecretResolutionError,
    );
  });

  it("throws when the env var is empty", async () => {
    process.env[ENV_VAR] = "";
    await expect(resolveSecretRef({ mount: "env", env_var: ENV_VAR })).rejects.toBeInstanceOf(
      SecretResolutionError,
    );
  });
});

describe("resolveSecretRef — file mount", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ez-secret-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the file contents, trimmed of surrounding whitespace", async () => {
    const path = join(dir, "secret");
    await writeFile(path, "  shhh-from-file\n");
    expect(await resolveSecretRef({ mount: "file", path })).toBe("shhh-from-file");
  });

  it("throws when the file does not exist", async () => {
    await expect(
      resolveSecretRef({ mount: "file", path: join(dir, "absent") }),
    ).rejects.toBeInstanceOf(SecretResolutionError);
  });

  it("throws when the file is empty (whitespace only)", async () => {
    const path = join(dir, "blank");
    await writeFile(path, "   \n");
    await expect(resolveSecretRef({ mount: "file", path })).rejects.toBeInstanceOf(
      SecretResolutionError,
    );
  });
});

describe("resolveSecretRef — vault mount", () => {
  it("throws (unimplemented)", async () => {
    await expect(
      resolveSecretRef({ mount: "vault", vault_path: "secret/data/better-auth" }),
    ).rejects.toBeInstanceOf(SecretResolutionError);
  });
});
