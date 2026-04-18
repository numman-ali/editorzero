/**
 * Typed span-attribute helpers (architecture.md §16.11).
 *
 * Emit attributes via these helpers instead of raw string keys so the
 * OTel attribute namespace stays coherent and a grep for
 * `"principal.kind"` finds every emission site. Every attribute builder
 * returns a `Record<string, string | number | boolean>` compatible with
 * `TracerSpan.setAttributes` and `Meter` instruments' `attrs` arg.
 */

import type { AgentId, CapabilityId, DocId, TokenId, UserId, WorkspaceId } from "@editorzero/ids";
import type { Principal } from "@editorzero/principal";
import type { Scope } from "@editorzero/scopes";

export type SpanAttrs = Record<string, string | number | boolean>;

export const attr = {
  /**
   * Attribution: who acted. Always included on any span inside the
   * capability dispatch path. `workspace_id` is required (every span
   * carries it — §16.11).
   */
  principal(p: Principal): SpanAttrs {
    const base: SpanAttrs = {
      "principal.kind": p.kind,
      "principal.id": p.id,
      "workspace.id": p.workspace_id,
    };
    if (p.kind === "user") {
      if (p.token_id !== null) base["principal.token_id"] = p.token_id;
      if (p.session_id !== null) base["principal.session_id"] = p.session_id;
    } else {
      base["principal.token_id"] = p.token_id;
      base["principal.token_kind"] = p.token_kind;
      if (p.owner_user_id !== null) base["principal.owner_user_id"] = p.owner_user_id;
      if (p.acting_as !== undefined) base["principal.acting_as"] = p.acting_as;
    }
    return base;
  },

  capability(id: CapabilityId, category: string): SpanAttrs {
    return {
      "capability.id": id,
      "capability.category": category,
    };
  },

  doc(id: DocId): SpanAttrs {
    return { "doc.id": id };
  },

  workspace(id: WorkspaceId): SpanAttrs {
    return { "workspace.id": id };
  },

  user(id: UserId): SpanAttrs {
    return { "user.id": id };
  },

  agent(id: AgentId): SpanAttrs {
    return { "agent.id": id };
  },

  token(id: TokenId): SpanAttrs {
    return { "token.id": id };
  },

  /** Required scopes for a capability — emitted on deny spans (§9.3). */
  requiredScopes(scopes: readonly Scope[]): SpanAttrs {
    return { "capability.required_scopes": scopes.join(",") };
  },
} as const;
