/**
 * Integration coverage for `createMcpHandler`: the full JSON-RPC
 * roundtrip through Hono + `StreamableHTTPTransport` (ADR 0026).
 *
 * The test wires a small Hono app — principal middleware with a
 * hard-coded `c.var.principal`, the factory handler at `/mcp` — and
 * drives it via the MCP SDK's `Client` + `StreamableHTTPClientTransport`
 * using Hono's `app.request` as the custom `fetch`. That gives us a
 * real protocol roundtrip (initialize → tools/list → tools/call)
 * without booting a TCP listener, so the test stays in the unit-lane
 * speed budget while still exercising the adapter's real
 * decision-points: registry → filter → registerTool → dispatcher →
 * CallToolResult framing.
 */

import type { Capability } from "@editorzero/capabilities";
import { createRegistry, registerCapability } from "@editorzero/capabilities";
import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { PermissionDeniedError } from "@editorzero/errors";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMcpHandler, type McpEnv } from "./create-mcp-handler";

function makeCap(opts: {
  id: string;
  summary: string;
  humanOnly?: boolean;
  surfaces?: readonly ("api" | "cli" | "mcp" | "ui")[];
}) {
  const id = opts.id;
  const typed: Capability<{ echo: string }, { echoed: string }> = {
    id: CapabilityId(id),
    category: "read",
    summary: opts.summary,
    input: z.object({ echo: z.string() }).strict(),
    output: z.object({ echoed: z.string() }).strict(),
    requires: [],
    ...(opts.humanOnly !== undefined && { humanOnly: opts.humanOnly }),
    audit: {
      subjectFrom: () => ({ kind: "workspace" }),
      effectOnAllow: () => ({ kind: "audit.access_log" }),
      effectOnDeny: (_input, reason) => ({
        kind: "deny",
        capability: CapabilityId(id),
        required_scopes: [],
        reason_code: reason.kind,
      }),
      effectOnError: () => ({
        kind: "error",
        capability: CapabilityId(id),
        error_code: "internal",
        retriable: false,
      }),
      collapsePolicy: { collapsible: false },
    },
    surfaces: opts.surfaces ?? ["mcp"],
    handler: async (_ctx, input) => ({ echoed: input.echo }),
  };
  return registerCapability(typed);
}

function makePrincipal(): UserPrincipal {
  return {
    kind: "user",
    id: UserId("018f0000-0000-7000-8000-000000000a01"),
    workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000b01"),
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function makeDispatcher(dispatch: Dispatcher["dispatch"]): Dispatcher {
  return { dispatch, deps: {} as Dispatcher["deps"] };
}

interface Harness {
  readonly client: Client;
  readonly dispatch: ReturnType<typeof vi.fn<Dispatcher["dispatch"]>>;
  readonly close: () => Promise<void>;
}

async function makeHarness(opts: {
  caps: readonly ReturnType<typeof makeCap>[];
  principal?: Principal;
  dispatchImpl?: Dispatcher["dispatch"];
}): Promise<Harness> {
  const principal = opts.principal ?? makePrincipal();
  const registry = createRegistry(opts.caps);
  const dispatch = vi.fn<Dispatcher["dispatch"]>(
    opts.dispatchImpl ?? (async () => ({ echoed: "default" })),
  );
  const dispatcher = makeDispatcher(dispatch);

  const app = new Hono<McpEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  app.all(
    "/mcp",
    createMcpHandler({
      registry,
      dispatcher,
      serverInfo: { name: "editorzero-test", version: "0.0.0-test" },
    }),
  );

  const client = new Client({ name: "editorzero-test-client", version: "0.0.0" });
  const url = new URL("http://localhost.test/mcp");
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init) => {
      const path = typeof input === "string" ? input : input.toString();
      return app.request(path, init);
    },
  });
  // exactOptionalPropertyTypes friction: SDK's Transport.sessionId?: string
  // typechecks as string when undefined should be assignable; cast for
  // integration-test scaffolding only.
  await client.connect(transport as Transport);

  return {
    client,
    dispatch,
    close: async () => {
      await client.close();
    },
  };
}

describe("createMcpHandler (JSON-RPC roundtrip)", () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  it("lists every mcp-surface capability as a tool", async () => {
    harness = await makeHarness({
      caps: [
        makeCap({ id: "doc.alpha", summary: "Alpha capability" }),
        makeCap({ id: "doc.beta", summary: "Beta capability" }),
      ],
    });

    const result = await harness.client.listTools();

    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["doc.alpha", "doc.beta"]);
    const alpha = result.tools.find((t) => t.name === "doc.alpha");
    expect(alpha?.description).toBe("Alpha capability");
    expect(alpha?.inputSchema.properties).toMatchObject({ echo: expect.any(Object) });
  });

  it("excludes humanOnly capabilities from the tool list", async () => {
    harness = await makeHarness({
      caps: [
        makeCap({ id: "doc.visible", summary: "Visible to agents" }),
        makeCap({ id: "doc.hidden", summary: "Human-only", humanOnly: true }),
      ],
    });

    const result = await harness.client.listTools();

    expect(result.tools.map((t) => t.name)).toEqual(["doc.visible"]);
  });

  it("excludes capabilities whose surfaces list does not include 'mcp'", async () => {
    harness = await makeHarness({
      caps: [
        makeCap({ id: "doc.mcp_only", summary: "MCP-surfaced", surfaces: ["mcp"] }),
        makeCap({ id: "doc.api_only", summary: "API-only", surfaces: ["api"] }),
      ],
    });

    const result = await harness.client.listTools();

    expect(result.tools.map((t) => t.name)).toEqual(["doc.mcp_only"]);
  });

  it("dispatches the capability with the request-resolved principal on tools/call", async () => {
    const principal = makePrincipal();
    harness = await makeHarness({
      caps: [makeCap({ id: "doc.alpha", summary: "Alpha" })],
      principal,
      dispatchImpl: async () => ({ echoed: "server-reply" }),
    });

    const result = await harness.client.callTool({
      name: "doc.alpha",
      arguments: { echo: "hello" },
    });

    expect(harness.dispatch).toHaveBeenCalledTimes(1);
    const invocation = harness.dispatch.mock.calls[0]?.[0] as DispatchInvocation;
    expect(invocation.capability_id).toBe(CapabilityId("doc.alpha"));
    expect(invocation.input).toEqual({ echo: "hello" });
    expect(invocation.principal).toBe(principal);
    expect(invocation.access.workspace_id).toBe(principal.workspace_id);

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]?.text ?? "")).toEqual({ echoed: "server-reply" });
  });

  it("maps EditorZeroError from dispatch to isError + structuredContent", async () => {
    harness = await makeHarness({
      caps: [makeCap({ id: "doc.alpha", summary: "Alpha" })],
      dispatchImpl: async () => {
        throw new PermissionDeniedError({
          reason: { kind: "missing_scope", required: ["doc:write"], principal_scopes: [] },
        });
      },
    });

    const result = await harness.client.callTool({
      name: "doc.alpha",
      arguments: { echo: "x" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "permission_denied" },
    });
  });

  it("derivation parity: tool list equals the registry's mcp-surface + not-humanOnly slice", async () => {
    // Contract invariant (AGENTS.md #4 + ADR 0026 commitments 1, 5): the
    // MCP tool list is **derived** from the registry, not maintained by
    // hand. The literal assertions above each exercise one filter case;
    // this one fixes the derivation itself — the set of ids in
    // `tools/list` must be exactly the set produced by applying the
    // public semantic filter (`surfaces.includes("mcp") && !humanOnly`)
    // to the registry's capabilities.
    //
    // The expected set is computed from the registry input using the
    // semantic predicate (not `isMcpTool`), so this test would fail if a
    // future refactor silently widened or narrowed `isMcpTool` beyond
    // the contract ADR 0026 encodes.
    const caps = [
      makeCap({ id: "doc.alpha", summary: "Alpha — mcp-surface, agent-safe" }),
      makeCap({ id: "doc.beta", summary: "Beta — mcp-surface, agent-safe" }),
      makeCap({
        id: "workspace.purge",
        summary: "Purge — mcp-surface but human-only",
        humanOnly: true,
      }),
      makeCap({
        id: "admin.ping",
        summary: "Ping — api-only, never exposed to mcp",
        surfaces: ["api"],
      }),
      makeCap({
        id: "doc.gamma",
        summary: "Gamma — multi-surface including mcp",
        surfaces: ["api", "cli", "mcp", "ui"],
      }),
    ];
    harness = await makeHarness({ caps });

    const result = await harness.client.listTools();
    const toolNames = result.tools.map((t) => t.name).sort();

    const expected = caps
      .filter((c) => c.surfaces.includes("mcp") && c.humanOnly !== true)
      .map((c) => c.id as string)
      .sort();

    expect(toolNames).toEqual(expected);
    expect(toolNames).toEqual(["doc.alpha", "doc.beta", "doc.gamma"]);
  });
});
