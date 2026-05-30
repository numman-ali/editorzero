## 4. Capability registry

### 4.1 Shape

The capability registry (`packages/capabilities/src/*.ts`) is the single source of truth (ADR 0009):

```ts
// packages/capabilities/src/kernel.ts
export interface Capability<I, O> {
  readonly id: CapabilityId;                    // "doc.update"
  readonly category: CapabilityCategory;        // mutation|read|auth|admin|system
  readonly summary: string;                     // human/agent doc
  readonly input: z.ZodType<I>;                 // zod v4
  readonly output: z.ZodType<O>;
  readonly requires: readonly Scope[];          // always checked (ADR 0016)
  readonly humanOnly?: boolean;                 // if true → kind=agent auto-denied
  readonly agentAllowed?: {                     // additionally required when kind=agent
    extraScopes?: Scope[];                      //   agent must have these ON TOP of `requires`
    maxConcurrent?: number;                     //   per-agent in-flight cap
  };
  readonly rateLimit?: {
    per: "principal" | "workspace" | "global";
    bucket: string;                             // shared bucket name
    per_minute: number;
    burst?: number;
  };
  readonly audit: {
    subjectFrom: (input: I) => { kind: SubjectKind; id?: string };
    effectOnAllow: (input: I, output: O) => AuditEffect;     // typed; see §16.3
    effectOnDeny:  (input: I, reason: DenyReason) => AuditDeny;   // F32
    effectOnError: (input: I, error: HandlerError) => AuditError; // F32
    collapsePolicy: CollapsePolicy;                          // reads only; enforced at runtime
  };
  readonly surfaces: readonly ("api"|"cli"|"mcp"|"ui")[]; // which surfaces expose this
  readonly deprecated?: { since: string; sunset: string; replacement?: CapabilityId };
  readonly handler: (ctx: CapabilityContext, input: I) => Promise<O>;
}
```

#### `agentAllowed` vs `requires` — authorization matrix (F23 fix)

| Principal kind | `humanOnly: true` | `humanOnly: false`, `agentAllowed` absent | `humanOnly: false`, `agentAllowed` present |
|---|---|---|---|
| `user`  | allowed iff user has `requires` | allowed iff user has `requires` | allowed iff user has `requires` (agent-extra-scopes irrelevant) |
| `agent` | **denied** regardless of scopes | **denied** (agents need explicit `agentAllowed`) | allowed iff agent has `requires` **and** `agentAllowed.extraScopes` (plus `owner.permissions ⊇ requires` when `acting_as`) |

Rule-of-thumb for new capabilities:
- **Safe reads and benign mutations:** `humanOnly: false`, `agentAllowed: { }` (same scopes as humans).
- **Power-user reads / mutations agents may use:** add `extraScopes` on top (e.g., `agent:create` for capabilities that create other agents).
- **Destructive or operator-scope:** `humanOnly: true` — surfaces still expose to API/CLI for ops tooling, but **not** to MCP (§15.1: MCP adapter filters `humanOnly` capabilities out).

- Schemas are **zod v4 StandardSchema-compatible** so the MCP SDK (v1 stable accepts zod v4), Hono's `@hono/zod-openapi`, and our CLI commander parser all consume the same object. Swapping to Valibot or ArkType later is a codemod, not a rewrite.
- The full `CapabilityContext` — the only thing a handler can touch — is spec'd in [§16.4](16-engineering-primitives-for-agentic-workflows.md#164-capabilitycontext--the-primitive-every-handler-consumes).

### 4.2 Canonical capability set (MVP)

See [Appendix A](appendix-a-capability-matrix.md#appendix-a--capability-matrix) for the exhaustive matrix. Groupings:

| Group | Capabilities |
|---|---|
| **workspace** | `workspace.create`, `workspace.update`, `workspace.get`, `workspace.list`, `workspace.delete`, `workspace.restore`, `workspace.purge`, `workspace.member_add`, `workspace.member_list`, `workspace.member_remove`, `workspace.member_update_role` |
| **collection** | `collection.create`, `collection.update`, `collection.move`, `collection.delete`, `collection.restore`, `collection.list` |
| **doc** | `doc.create`, `doc.get`, `doc.list`, `doc.update`, `doc.update_from_markdown`, `doc.rename`, `doc.move`, `doc.delete`, `doc.restore`, `doc.purge`, `doc.publish`, `doc.unpublish` |
| **block** | `block.update`, `block.insert`, `block.remove`, `block.set_visibility` (doc-level wrappers also accept block ops; these are the granular forms) |
| **version** | `version.create`, `version.list`, `version.get`, `version.restore` |
| **comment** | `comment.create`, `comment.update`, `comment.resolve`, `comment.delete`, `comment.list` |
| **attachment** | `attachment.request_upload`, `attachment.confirm_upload`, `attachment.get`, `attachment.delete` |
| **search** | `search.query`, `search.reindex` (admin) |
| **permission** | `permission.grant`, `permission.revoke`, `permission.list` |
| **principal** | `agent.create`, `agent.rename`, `agent.revoke`, `agent.list`, `token.create`, `token.revoke`, `token.list` |
| **mirror** | `mirror.configure`, `mirror.enable`, `mirror.disable`, `mirror.push_now`, `mirror.reset_state`, `mirror.reset_auth` |
| **webhook** | `webhook.create`, `webhook.update`, `webhook.list`, `webhook.get`, `webhook.delete`, `webhook.test_delivery`, `webhook.rotate_secret`, `webhook.refresh_dns` |
| **admin** | `admin.health`, `admin.metrics`, `admin.diagnose`, `admin.purge_runner`, `admin.secret_rotate`, `admin.job_*`, `admin.queue_*`, `admin.reindex_workspace`, `admin.reembed_workspace`, `admin.evict_doc`, `admin.unlock_doc` |
| **introspection** | `capabilities.list`, `capabilities.describe` (for agent discovery) |

`capabilities.describe` returns schemas from the registry — agents can self-discover the contract without human-readable docs. Powers the MCP tool/resource split (§5.3).

### 4.3 Lifecycle and discovery

- Registration: modules register capabilities by import; a build-time barrel assembles the `Map<id, Capability>`.
- Changes: a new capability lands with its contract test (ADR 0009). Removing or renaming a capability is a breaking change — see [§4.4 Versioning](#44-versioning).
- Discovery: `capabilities.list` is itself a capability; agents self-discover.

### 4.4 Versioning

MVP is `v1`. Breaking changes ship a new capability id alongside (`doc.update_v2`) with the old kept for a deprecation window. The registry exposes a `deprecated: { since, sunset, replacement }` field intended to be consumed by the four surface adapters once they land; OpenAPI will mark deprecated operations, MCP tool descriptions will link the replacement, and CLI/UI surfaces will surface the warning.
