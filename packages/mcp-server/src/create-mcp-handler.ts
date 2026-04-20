/**
 * `createMcpHandler` — MCP-over-Streamable-HTTP adapter factory
 * (ADR 0026).
 *
 * Returns a terminal Hono handler suitable for mounting at
 * `app.all("/mcp", principalMiddleware, createMcpHandler({...}))`.
 * The caller owns the route path and the principal middleware chain;
 * this factory only knows "given a request with `c.var.principal`
 * populated, translate MCP JSON-RPC into capability dispatches and
 * back".
 *
 * ## Slice-1 implementation shape
 *
 * The handler constructs a fresh `McpServer` + `StreamableHTTPTransport`
 * per request and registers the filtered tool list each time. This
 * matches ADR 0026's illustrative code block. **Transport/server object
 * lifetime is not an ADR commitment** (ADR 0026 commitment 1 round-2):
 * a future slice may shift to a shared server with per-request
 * Principal injection through a different Hono-owned seam, and nothing
 * about the handler's external contract changes.
 *
 * Why per-request for slice 1:
 *
 *  - **Stateless anyway.** No session continuation, no event store, no
 *    `Mcp-Session-Id`. The server holds no state worth persisting
 *    across requests in this slice.
 *  - **Principal-per-request.** The tool callback closes over a
 *    specific request's Principal value. Re-using a server across
 *    requests without a per-tool-call Principal-injection seam would
 *    mix principals across concurrent requests.
 *  - **Tools-only, few caps.** Registering O(N) tools where N is the
 *    current capability-registry size is dominated by Hocuspocus /
 *    dispatch costs, not by `registerTool` calls.
 *
 * ## What the handler does NOT do
 *
 *  - **No OAuth metadata routes.** Slice 1 does not mount
 *    `/.well-known/oauth-protected-resource` or
 *    `/.well-known/oauth-authorization-server` (ADR 0026 commitment 6).
 *    The caller must not mount them either until the OAuth slice lands.
 *  - **No resources, no prompts, no notifications.** Tools only.
 *  - **No rate limiting.** Inherits whatever the trunk's rate-limit
 *    middleware provides (none, currently).
 *  - **No per-tool auth.** Every tool the registry surfaces as an MCP
 *    tool is callable by any principal the middleware resolved. The
 *    dispatcher's permission gate enforces per-capability scope /
 *    workspace / role checks downstream.
 */

import type { Registry } from "@editorzero/capabilities";
import type { Dispatcher } from "@editorzero/dispatcher";
import type { Principal } from "@editorzero/principal";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context, Handler } from "hono";
import { toToolConfig } from "./tool-config";
import { isMcpTool } from "./tool-filter";
import { runTool } from "./tool-handler";

export interface McpHandlerDeps {
  readonly registry: Registry;
  readonly dispatcher: Dispatcher;
  /**
   * Server identity advertised in the MCP initialize handshake. Matches
   * what `McpServer`'s `Implementation` field carries through to the
   * client's `serverInfo` view.
   */
  readonly serverInfo: {
    readonly name: string;
    readonly version: string;
  };
}

export interface McpEnv {
  readonly Variables: {
    readonly principal: Principal;
  };
}

export function createMcpHandler(deps: McpHandlerDeps): Handler<McpEnv> {
  const { registry, dispatcher, serverInfo } = deps;

  // Filter once at factory time — the registry is read-only after
  // construction (packages/capabilities/src/registry.ts), so the tool
  // list is stable across requests. Config objects are stable too
  // (`toToolConfig` is pure), so we precompute them.
  const tools = registry.list().filter(isMcpTool);
  const toolConfigs = tools.map((cap) => ({ cap, config: toToolConfig(cap) }));

  return async (c: Context<McpEnv>) => {
    const principal = c.var.principal;
    const server = new McpServer({
      name: serverInfo.name,
      version: serverInfo.version,
    });

    for (const { cap, config } of toolConfigs) {
      server.registerTool(cap.id, config, async (args: unknown) => {
        return await runTool({
          capability: cap,
          input: args,
          principal,
          dispatcher,
        });
      });
    }

    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    const response = await transport.handleRequest(c);
    return response ?? c.body(null, 204);
  };
}
