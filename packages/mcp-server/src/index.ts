/**
 * `@editorzero/mcp-server` — MCP-over-Streamable-HTTP adapter
 * (ADR 0009, ADR 0021, ADR 0026).
 *
 * Public surface:
 *
 *  - `createMcpHandler({ registry, dispatcher, serverInfo })` — returns
 *    a Hono handler the caller mounts at `/mcp` behind the trunk's
 *    principal middleware.
 *  - `isMcpTool(cap)` — the filter every MCP adapter applies to
 *    registry capabilities (`surfaces.includes("mcp") && !humanOnly`).
 *    Exported for contract tests that assert parity between the
 *    registry + MCP tool list.
 *  - `toToolConfig(cap)` — projects a `Capability` into the config the
 *    SDK's `McpServer.registerTool` consumes. Exported for the same
 *    contract-test reason.
 *
 * Not exported: the `runTool` tool-handler is an internal wiring detail
 * of the adapter, not a composition seam.
 */

export type { McpEnv, McpHandlerDeps } from "./create-mcp-handler";
export { createMcpHandler } from "./create-mcp-handler";
export type { McpToolConfig } from "./tool-config";
export { NonObjectInputSchemaError, toToolConfig } from "./tool-config";
export { isMcpTool } from "./tool-filter";
