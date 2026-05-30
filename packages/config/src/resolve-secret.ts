/**
 * Resolve a {@link SecretRef} to its plaintext value.
 *
 * The provider contracts in `./secrets` describe *what* a secret provider
 * offers (startup vs. rotatable, caching, version windows); this is the
 * concrete *how* for the `env` and `file` mounts they resolve through. It
 * lives in `@editorzero/config` because reading `process.env` or a secret
 * file is exactly the boundary this package owns — the only sanctioned
 * `process.env` access in the monorepo (§16.8 `no-process-env`).
 *
 * `vault` is intentionally unimplemented: no vault integration ships
 * in-tree yet, and failing loud beats silently handing back an empty
 * secret a deploy would then sign tokens with.
 */

import { readFile } from "node:fs/promises";

import type { SecretRef } from "./secrets";

/** Thrown when a `SecretRef` cannot be resolved to a non-empty value. */
export class SecretResolutionError extends Error {
  override readonly name = "SecretResolutionError";
}

export async function resolveSecretRef(ref: SecretRef): Promise<string> {
  switch (ref.mount) {
    case "env": {
      const value = process.env[ref.env_var];
      if (value === undefined || value.length === 0) {
        throw new SecretResolutionError(`secret env var ${ref.env_var} is unset or empty`);
      }
      return value;
    }
    case "file": {
      let raw: string;
      try {
        raw = await readFile(ref.path, "utf8");
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new SecretResolutionError(`secret file ${ref.path} could not be read: ${reason}`);
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        throw new SecretResolutionError(`secret file ${ref.path} is empty`);
      }
      return trimmed;
    }
    case "vault":
      throw new SecretResolutionError(
        `vault secret resolution is not implemented (no vault integration shipped); ` +
          `vault_path=${ref.vault_path}`,
      );
  }
}
