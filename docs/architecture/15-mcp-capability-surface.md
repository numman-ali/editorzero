## 15. MCP capability surface (draft)

### 15.1 Derivation

Same registry → MCP tools (per ADR 0009):

*[Realised in slice 1 by `packages/mcp-server` — `createMcpHandler({ registry, dispatcher, serverInfo })` returns a Hono handler the trunk mounts at `/mcp` behind the same principal middleware `/docs/*` uses (cookie auth, transitional). The actual filter is `isMcpTool(cap)` (`cap.surfaces.includes("mcp") && cap.humanOnly !== true`), not the `category !== "admin"` shown in the pseudocode below; ADR 0026 documents the six load-bearing commitments — principal via Hono chain, deliberately stateless, registry → tool loop, three-way error cut, `humanOnly` structural filter, no slice-1 OAuth discovery. `outputSchema` is not published in slice 1; outputs travel as JSON in `content[0].text`. Contract-matrix parity at the adapter and trunk layers is enforced by `packages/mcp-server/src/create-mcp-handler.integration.test.ts` and `packages/api-server/src/composition/mcp-chain.integration.test.ts`.]*

```
packages/mcp-server/src/index.ts
  import { capabilities } from "@editorzero/capabilities";
  for (const cap of capabilities) {
    if (cap.surfaces.includes("mcp") && cap.category !== "admin") {
      server.registerTool({
        name: cap.id,                    // "doc.update"
        description: cap.summary,
        inputSchema: cap.input,          // zod v4
        outputSchema: cap.output,
        handler: async (input, mcpCtx) => {
          const principal = await resolvePrincipal(mcpCtx.auth);
          return dispatcher.invoke(cap.id, { principal, tenant }, input);
        },
      });
    }
  }
```

### 15.2 Resources

Read-side only. Each resource is backed by a read capability:

| URI template | Handler |
|---|---|
| `editorzero://workspace/{id}/doc/{id}` | `doc.get` → Markdown per ADR 0013 |
| `editorzero://workspace/{id}/doc/{id}/blocks` | `doc.get` → block array JSON |
| `editorzero://workspace/{id}/doc-tree` | `collection.list` + `doc.list` joined |
| `editorzero://workspace/{id}/schema` | static: block-type schema (for agent authoring) |

### 15.3 Toolsets

Grouped via `X-MCP-Tools` header; declared in the registry via `cap.tags: ["read", "write", "admin"]`. `--read-only` mode filters category=`read`.

### 15.4 Session lifecycle (ADR 0009)

- Keepalive SSE every 15s.
- `Mcp-Session-Id` + `Last-Event-Id` for resume.
- `tool_call_id` persisted 24h for interrupted calls: `GET /mcp/tool-calls/{id}` returns status/result.
- Revocation: Better Auth revokes credential → MCP session manager closes bound sessions (ADR 0016).

### 15.5 Prompts (deferred)

Capability registry has a prompts extension point; not populated in MVP. A user who wants templated authoring (`"draft a meeting-notes doc from these talking points"`) gets a resource-backed template. Real deliverable in Phase 4+.
