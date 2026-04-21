/**
 * `runTool` — the MCP-tool side of the three-way error cut that ADR
 * 0026 commitment 4 pins.
 *
 * Behaviour:
 *
 *  1. Dispatches the capability through the injected `Dispatcher` with
 *     `access.workspace_id` derived from the request-resolved
 *     `principal.workspace_id` (same pattern every API route uses;
 *     `packages/api-server/src/routes/docs/*.ts`).
 *  2. On success — returns `{ content: [{type: "text", text: JSON.stringify(output) }] }`.
 *     `structuredContent` is intentionally not populated in slice 1
 *     (see `tool-config.ts` header + ADR 0026 § Deferred).
 *  3. On `EditorZeroError` — returns `{ isError: true, content:
 *     [{type: "text", text}], structuredContent: { error:
 *     { code, message } } }` where `text` + `message` are the same
 *     string chosen by `projectError`. Every surface keys on `code`
 *     (packages/errors/src/index.ts) as the stable identifier; MCP
 *     clients read `code` for routing and `message` for display.
 *     MCP-native framing via `structuredContent`, not AXI verbatim
 *     (slice-contract separation per ADR 0026 commitment 4).
 *  4. On unexpected throws — rethrows. The SDK catches and converts to
 *     `{ isError: true, content: [{type: "text", text: err.message}] }`
 *     (model-visible), which is an acceptable first-slice trade-off
 *     given `EditorZeroError` already covers the dispatcher / handler
 *     deny/error paths. A future slice can wrap for a catch-all
 *     internal-error envelope.
 *
 * **Message-exposure policy.** `projectError` whitelists the
 * user-safe domain classes (`ValidationError`, `PermissionDeniedError`,
 * `NotFoundError`, `RateLimitError`, `ConflictError`,
 * `ResourceLimitError`) — their messages are constructed from
 * structured, user-facing fields and are safe to surface to the model.
 * Internal/runtime classes (`UpstreamError`, `TransactCalledTwiceError`,
 * `InternalError`, and any future subclass that doesn't explicitly
 * opt into the whitelist) emit a generic text keyed off `code` —
 * their messages can leak upstream service names, capability IDs,
 * doc IDs, or trace identifiers that shouldn't end up in a model
 * context or a surface the user sees. The `code` stays stable so
 * MCP clients + humans still have a routing key; the unsafe detail
 * stays in server-side logs via `trace_id` (ADR 0019).
 *
 * The `McpError` (JSON-RPC protocol-level errors) third arm of the cut
 * does not fire from inside `runTool`: the middleware guarantees
 * `principal` is present, and the SDK itself emits `McpError` on
 * `inputSchema` validation failure before the callback runs. Adapter-
 * internal contract violations (no principal, no dispatcher) surface
 * as plain throws caught by the SDK default — the `runTool` caller
 * handles them by never calling it with a missing principal, not by
 * throwing `McpError` here.
 */

import type { AnyCapability } from "@editorzero/capabilities";
import type { Dispatcher } from "@editorzero/dispatcher";
import {
  ConflictError,
  EditorZeroError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ResourceLimitError,
  ValidationError,
} from "@editorzero/errors";
import type { Principal } from "@editorzero/principal";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface RunToolParams {
  readonly capability: AnyCapability;
  readonly input: unknown;
  readonly principal: Principal;
  readonly dispatcher: Dispatcher;
}

export async function runTool(params: RunToolParams): Promise<CallToolResult> {
  const { capability, input, principal, dispatcher } = params;
  try {
    const output = await dispatcher.dispatch({
      capability_id: capability.id,
      input,
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
    };
  } catch (err) {
    if (err instanceof EditorZeroError) {
      const projected = projectError(err);
      return {
        isError: true,
        content: [{ type: "text", text: projected.message }],
        structuredContent: { error: projected },
      };
    }
    throw err;
  }
}

/**
 * Generic message used for every non-whitelisted `EditorZeroError`
 * subclass. Stable + code-keyed so MCP clients can still route;
 * distinct from the empty string / missing-field case so the
 * structuredContent envelope stays well-formed. Matches the tone of
 * the SDK's default catch-all path (which also emits a generic
 * text), but threaded here so `content[0].text` and
 * `structuredContent.error.message` stay in sync.
 */
const INTERNAL_ERROR_MESSAGE = "internal error";

/**
 * Whitelist of user-safe `EditorZeroError` subclasses whose
 * `message` is constructed from fields the model can safely see.
 * All other subclasses — present or future — fall through to the
 * internal-error branch of `projectError`. This posture is
 * fail-safe: adding a new subclass in `@editorzero/errors` without
 * touching this file emits generic text rather than silently
 * leaking whatever the subclass's constructor put in its message.
 */
function isUserSafeError(err: EditorZeroError): boolean {
  return (
    err instanceof ValidationError ||
    err instanceof PermissionDeniedError ||
    err instanceof NotFoundError ||
    err instanceof RateLimitError ||
    err instanceof ConflictError ||
    err instanceof ResourceLimitError
  );
}

/**
 * Projects a domain error to the MCP `{code, message}` shape that
 * fills both `content[0].text` and `structuredContent.error`.
 * Whitelisted subclasses expose their message verbatim; everything
 * else emits `INTERNAL_ERROR_MESSAGE` keyed by the stable `code`.
 */
function projectError(err: EditorZeroError): { code: string; message: string } {
  if (isUserSafeError(err)) {
    return { code: err.code, message: err.message };
  }
  return { code: err.code, message: INTERNAL_ERROR_MESSAGE };
}
