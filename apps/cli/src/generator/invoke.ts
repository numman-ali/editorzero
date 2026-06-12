/**
 * Capability-command runtime (ADR 0021 §CLI generator, ADR 0025 §whoami).
 *
 * `runCapability` is the single dispatch path every generated CLI
 * command funnels through. It:
 *
 *   1. Parses the raw citty args through the capability's zod `input`
 *      schema. The citty arg map is string-shaped; zod coerces and
 *      validates against the real types. Invalid input surfaces as
 *      `cli_validation_error` on stdout and exits 1 without a round-
 *      trip.
 *
 *   2. Resolves the HTTP binding via `deriveHttpBinding(capability)`
 *      (one lookup per invocation — cheap). Splits the validated
 *      input into path-param, query, body parts according to verb.
 *
 *   3. Reads the local credential through the injected `store`. No
 *      credential → emit `auth_expired` on stdout, exit 1 (same
 *      posture as `ez auth whoami`). 401 from the server → clear
 *      the local credential + emit `auth_expired`.
 *
 *   4. Fires the request through the injected `fetch`. The fetch is
 *      a plain `typeof fetch`, not the typed `hc<AppType>` client —
 *      the generator is schema-agnostic by design (it reads the
 *      capability's own zod schemas at runtime rather than the
 *      compile-time RPC type tree). The typed client remains
 *      available for hand-written callers (see `ez auth whoami` →
 *      `client.infra.whoami.$get`).
 *
 *   5. Non-200/201 responses are projected through a small error map:
 *      401 → auth_expired (with local credential cleared); 403 →
 *      permission_denied; 404 → not_found; 400 → validation; 5xx →
 *      request_failed. Each carries the server's `{ error: code }`
 *      shape when available.
 *
 *   6. 200/201 responses parse through the capability's zod `output`
 *      schema and emit on stdout as one-line JSON. The parse is
 *      defensive: a server change that breaks the output shape
 *      surfaces as `schema_mismatch` rather than a silent wrong-shape
 *      write. (The server validates on the way out too, but the
 *      client's own re-parse is what types the result inside the
 *      CLI — the trust boundary is the wire.)
 */

import {
  type AnyCapability,
  deriveHttpBinding,
  expandPathTemplate,
  type HttpBinding,
} from "@editorzero/capabilities";

import type { AuthCredentialStore } from "../credential-store";
import { emit, emitError } from "../io";
import { deriveJsonFlagKeys } from "./flags";

export interface RunCapabilityArgs {
  readonly baseUrl: string;
  /**
   * Raw citty-parsed arg map. Values are strings (or `undefined` for
   * absent optionals). Zod re-parses through the capability's input
   * schema to produce the actual typed object.
   */
  readonly rawArgs: Readonly<Record<string, unknown>>;
}

export interface RunCapabilityDeps {
  readonly store: AuthCredentialStore;
  readonly fetch: typeof fetch;
  readonly stdout: NodeJS.WritableStream;
}

export async function runCapability(
  capability: AnyCapability,
  args: RunCapabilityArgs,
  deps: RunCapabilityDeps,
): Promise<number> {
  const { baseUrl, rawArgs } = args;
  const { store, fetch: fetchImpl, stdout } = deps;

  // 1. zod input parse. We only include keys that match the input
  //    schema's shape to avoid citty's defaults (`_`, positional
  //    leftovers, the helper `--` stop marker) tripping `strict()`.
  const shapeKeys = Object.keys(
    (capability.input as unknown as { shape: Record<string, unknown> }).shape,
  );
  const filtered: Record<string, unknown> = {};
  for (const key of shapeKeys) {
    if (rawArgs[key] !== undefined) filtered[key] = rawArgs[key];
  }
  // 1a. JSON-valued flags (structured fields — see `deriveJsonFlagKeys`):
  //     decode the string transport before the zod parse, the same way
  //     Hono decodes the HTTP body before the validator. A malformed
  //     document is a typed CLI validation error, not a crash and not a
  //     confusing zod "expected object, received string".
  const jsonKeys = deriveJsonFlagKeys(capability.input);
  for (const key of jsonKeys) {
    const raw = filtered[key];
    if (typeof raw !== "string") continue;
    try {
      filtered[key] = JSON.parse(raw);
    } catch {
      emitError(
        "cli_validation_error",
        `--${key} expects a JSON document (e.g. '{"kind": "..."}'); the value did not parse.`,
        { issues: [{ path: [key], message: "invalid JSON" }] },
        stdout,
      );
      return 1;
    }
  }
  const parsed = capability.input.safeParse(filtered);
  if (!parsed.success) {
    emitError(
      "cli_validation_error",
      "One or more flags are missing or invalid. See --help for the expected shape.",
      { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      stdout,
    );
    return 1;
  }
  const input = parsed.data as Record<string, unknown>;

  // 2. credential check.
  const credential = await store.read();
  if (credential === null) {
    emitError(
      "auth_expired",
      "No local credential. Run `ez auth login` to authenticate.",
      {},
      stdout,
    );
    return 1;
  }

  // 3. binding + URL.
  const binding = deriveHttpBinding(capability);
  const url = buildUrl(baseUrl, binding, input);

  // 4. request.
  const init: RequestInit = {
    method: binding.verb,
    headers: {
      ...credential,
      accept: "application/json",
      ...(binding.verb === "POST" && binding.bodyOrQueryKeys.length > 0
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(binding.verb === "POST" && binding.bodyOrQueryKeys.length > 0
      ? { body: JSON.stringify(pickKeys(input, binding.bodyOrQueryKeys)) }
      : {}),
  };
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    emitError(
      "network_error",
      "Could not reach the editorzero API. Check `--base-url` and that the server is running.",
      { message: (err as Error).message ?? "unknown" },
      stdout,
    );
    return 1;
  }

  // 5. status map.
  if (res.status === 401) {
    await store.clear();
    emitError(
      "auth_expired",
      "Session expired. Run `ez auth login` to re-authenticate.",
      {},
      stdout,
    );
    return 1;
  }
  if (res.status === 403) {
    emitError(
      "permission_denied",
      `The current principal lacks the required scopes for '${capability.id}'.`,
      { required_scopes: capability.requires },
      stdout,
    );
    return 1;
  }
  if (res.status === 404) {
    emitError("not_found", "The requested resource does not exist or is not visible.", {}, stdout);
    return 1;
  }
  if (res.status === 400) {
    const body = await readErrorBody(res);
    emitError(
      "validation",
      "The server rejected the request as invalid.",
      { server: body },
      stdout,
    );
    return 1;
  }
  if (res.status !== 200 && res.status !== 201) {
    const body = await readErrorBody(res);
    emitError(
      "request_failed",
      `Unexpected server response (status ${res.status}).`,
      { status: res.status, server: body },
      stdout,
    );
    return 1;
  }

  // 6. success parse.
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    emitError(
      "schema_mismatch",
      "Server returned a response that was not valid JSON.",
      { message: (err as Error).message ?? "unknown" },
      stdout,
    );
    return 1;
  }
  const output = capability.output.safeParse(body);
  if (!output.success) {
    emitError(
      "schema_mismatch",
      "Server response did not match the capability's output schema. This usually means the CLI is out of date relative to the server.",
      { issues: output.error.issues.map((i) => ({ path: i.path, message: i.message })) },
      stdout,
    );
    return 1;
  }
  emit(output.data, stdout);
  return 0;
}

function buildUrl(baseUrl: string, binding: HttpBinding, input: Record<string, unknown>): string {
  const paramValue = binding.paramName !== null ? String(input[binding.paramName]) : null;
  const path = expandPathTemplate(binding.pathTemplate, binding.paramName, paramValue);
  if (binding.verb === "GET" && binding.bodyOrQueryKeys.length > 0) {
    const qs = new URLSearchParams();
    for (const key of binding.bodyOrQueryKeys) {
      const v = input[key];
      if (v !== undefined && v !== null) qs.set(key, String(v));
    }
    const qsStr = qs.toString();
    return `${baseUrl}${path}${qsStr.length > 0 ? `?${qsStr}` : ""}`;
  }
  return `${baseUrl}${path}`;
}

function pickKeys(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

async function readErrorBody(res: Response): Promise<unknown> {
  // A Response body can only be consumed once, so read it as text first
  // and attempt a JSON parse afterwards. This keeps both the structured
  // `{error: code}` server shape and the plain-text-from-proxies fallback
  // addressable from one path.
  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
