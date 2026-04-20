/**
 * `isMcpTool` — the filter every MCP-adapter entry runs on a capability
 * before registering it as a tool (ADR 0026 commitments 3 + 5).
 *
 * Two conditions:
 *
 *   1. `cap.surfaces.includes("mcp")` — adapter-surface opt-in.
 *      Capabilities that list `"mcp"` in their `surfaces` are the ones
 *      the capability author has designed for MCP-tool shape (args the
 *      LLM can reason about, output the model can consume). A
 *      capability absent from the list is not silently surfaced as a
 *      tool even if its zod input would technically work.
 *
 *   2. `cap.humanOnly !== true` — structural exclusion. `humanOnly`
 *      marks capabilities agents have no legitimate path to
 *      (billing-admin edge cases, surfaces that require UI confirmation
 *      before effect). The adapter omits them from `list_tools` — not
 *      "expose-and-deny" — because listing them would imply an agent
 *      could call them (ADR 0026 commitment 5; Codex review).
 *
 * Both conditions are necessary. A capability with `humanOnly: true`
 * but `surfaces.includes("mcp")` is still a mistake the registry would
 * report elsewhere (contract-matrix parity failure); this filter is
 * defensive at the adapter boundary so a bad cell doesn't leak to the
 * MCP surface.
 */

import type { AnyCapability } from "@editorzero/capabilities";

export function isMcpTool(cap: AnyCapability): boolean {
  return cap.surfaces.includes("mcp") && cap.humanOnly !== true;
}
