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
 *     [{type: "text", text: err.message}], structuredContent: { error:
 *     { code: err.code, ...err-specific fields } } }`. The error code
 *     is the stable identifier every surface keys on
 *     (packages/errors/src/index.ts). MCP-native framing via
 *     `structuredContent`, not AXI verbatim (slice-contract separation
 *     per ADR 0026 commitment 4).
 *  4. On unexpected throws — rethrows. The SDK catches and converts to
 *     `{ isError: true, content: [{type: "text", text: err.message}] }`
 *     (model-visible), which is an acceptable first-slice trade-off
 *     given `EditorZeroError` already covers the dispatcher / handler
 *     deny/error paths. A future slice can wrap for a catch-all
 *     internal-error envelope.
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
import { EditorZeroError } from "@editorzero/errors";
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
      return {
        isError: true,
        content: [{ type: "text", text: err.message }],
        structuredContent: {
          error: projectErrorFields(err),
        },
      };
    }
    throw err;
  }
}

function projectErrorFields(err: EditorZeroError): Record<string, unknown> {
  // Keep this branch narrow and typed — each subclass contributes the
  // fields its `code` implies. No untyped `as` on `err`; `code` is a
  // discriminant and the rest comes from the instanceof narrow.
  const base: Record<string, unknown> = {
    code: err.code,
    message: err.message,
  };
  // Subclass-specific fields land in `structuredContent.error` alongside
  // `code` so an MCP client can key on `error.code` and optionally read
  // `error.<extra>` when present. The source of truth for which fields
  // each subclass owns lives in `@editorzero/errors` — mirror only what
  // a model-visible surface benefits from. `PermissionDeniedError`'s
  // full `reason` shape is internal audit detail; the stable `code`
  // suffices for model-side routing.
  return base;
}
