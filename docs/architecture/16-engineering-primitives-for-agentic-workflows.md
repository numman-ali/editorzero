## 16. Engineering primitives for agentic workflows

This section specifies **how the repo is organized so coding agents (and disciplined humans) land high-quality, non-regressing changes at speed**. It is the operational instantiation of [§1.1 Design posture](01-purpose.md#11-design-posture--engineering-for-coding-agents).

### 16.1 Monorepo layout

pnpm workspaces, single root `tsconfig.json` with project references, single `package.json` for dev deps, per-package `package.json` for runtime deps.

```
editorzero/
├── apps/
│   ├── app/                       # Vite + React SPA (ADR 0027/0028) — editor UI
│   ├── admin/                     # operator console, gated (SPA)
│   └── cli/                       # Bun-compiled CLI from registry (ADR 0021)
├── packages/
│   ├── ids/                       # Branded ID types + parsers (no runtime deps)
│   ├── scopes/                    # Scope vocabulary + helpers
│   ├── principal/                 # Principal type + resolve()
│   ├── audit/                     # AuditEffect union + writer interface
│   ├── capabilities/              # THE registry — one file per capability
│   │   ├── src/
│   │   │   ├── kernel.ts          #   Capability<I,O> + CapabilityContext types
│   │   │   ├── registry.ts        #   barrel: Map<CapabilityId, Capability>
│   │   │   ├── doc/
│   │   │   │   ├── update.ts      #   implements "doc.update"
│   │   │   │   ├── update.unit.test.ts
│   │   │   │   ├── create.ts
│   │   │   │   └── …
│   │   │   ├── workspace/…
│   │   │   └── …
│   │   └── package.json
│   ├── dispatcher/                # Auth + permission + rate-limit + audit + span
│   ├── auth/                      # Better Auth config + plugin wiring (infra)
│   ├── auth-service/              # Service-layer wrappers (F28): resolveSession,
│   │                              #   revokeAgent, rotateToken, issueAgentKey, etc.
│   │                              #   Capabilities import from here, not from `auth`.
│   ├── db/                        # Kysely + Atlas migrations + TenantScopedDb
│   │   ├── src/
│   │   │   ├── schema/            #   .sql files; Atlas-managed
│   │   │   ├── generated/         #   kysely-codegen output; committed
│   │   │   ├── tenant.ts          #   TenantScopedDb wrapper + AsyncLocalStorage
│   │   │   └── repos/             #   repository layer — one file per aggregate
│   │   │       ├── docs.ts        #   docRepo.findById, docRepo.insert, …
│   │   │       └── …
│   │   └── …
│   ├── sync/                      # Hocuspocus integration + ctx.transact impl
│   ├── blocks/                    # Block specs (ADR 0013) — one file per block type
│   │   ├── src/
│   │   │   ├── kernel.ts          #   BlockTypeSpec<Attrs, …> type + tier union
│   │   │   ├── core/
│   │   │   │   ├── heading.ts     #   editorzero:core/heading
│   │   │   │   ├── heading.prop.test.ts
│   │   │   │   └── …
│   │   │   └── directive/…
│   ├── search/                    # SearchService + FTS + vector drivers
│   ├── jobs/                      # JobService + pg-boss + SQLite drivers
│   ├── mirror/                    # git + S3 sinks + projection pipeline
│   ├── mcp-server/                # MCP derivation from registry (ADR 0026)
│   ├── api-server/                # Hono routes from registry + OpenAPI gen (ADR 0021)
│   ├── api-client/                # Typed-RPC client via `hc<AppType>` (ADR 0021)
│   ├── observability/             # OTel SDK + shared tracer/logger/meter
│   ├── contract-tests/            # Cross-surface parity matrix (generated)
│   └── e2e/                       # Playwright + axe
├── ops/
│   ├── docker/                    # Dockerfile + compose.yaml
│   ├── grafana/                   # Dashboards
│   └── scripts/                   # one-shot operator tools
├── docs/                          # ADRs, architecture, runbook, threat model
└── .github/                       # OSS hygiene
```

**Package boundaries are contracts.** A package's public exports are its `index.ts` barrel; anything not exported is private. Cross-package imports go through the barrel, never deep paths. Enforced by a Biome rule.

### 16.2 Layered architecture (per package, and across them)

Import direction is strictly downward. Higher layers import from lower; never the reverse.

```
  ┌───────────────────────────────────────────────┐
  │ Surface adapters (api-server, cli,            │
  │ mcp-server, app — the Vite SPA)               │   Adapters only.
  └───────────────────┬───────────────────────────┘   No business logic.
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Capability layer (packages/capabilities)      │   Declarative: shape +
  │   one Capability<I,O> per mutation or read    │   handler calling services.
  └───────────────────┬───────────────────────────┘
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Dispatcher (packages/dispatcher)              │   Cross-cutting:
  │   resolve principal, permission check,        │   auth, permission,
  │   rate limit, audit write, span               │   rate, audit, span.
  └───────────────────┬───────────────────────────┘   Unknown to services.
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Service layer (per-domain packages: docs,     │   Business logic.
  │ search, mirror, jobs)                         │   Pure functions over
  │   services take typed inputs, return typed    │   repo + primitives.
  │   outputs, call repos, never surfaces         │   Single responsibility.
  └───────────────────┬───────────────────────────┘
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Repository layer (packages/db/repos)          │   Persistence only.
  │   Kysely queries via TenantScopedDb           │   No business logic.
  │   return typed domain rows                    │   One repo per aggregate.
  └───────────────────┬───────────────────────────┘
                      ▼
  ┌───────────────────────────────────────────────┐
  │ Infrastructure (packages/db, sync, auth,      │   Framework adapters.
  │ observability, jobs drivers)                  │   Thin; wrap vendor APIs.
  └───────────────────────────────────────────────┘
```

The surface-adapters box includes `api-server` / `mcp-server` at `packages/*` and `apps/cli` / `apps/app` (Vite SPA) per ADR 0021/0027. `api-client` (typed-RPC client via `hc<AppType>`) is not a surface adapter itself — it rides alongside `api-server` for consumers, so it sits at the capability-layer boundary rather than in this diagram. Lint rules derived from this section will crystallize as a dedicated `@editorzero/arch-lint` package when it lands.

**Layer import rules (enforced by Biome + custom tsmorph lint):**

- `capabilities/*` may import from: `ids`, `scopes`, `principal`, `audit`, `auth-service`, domain-service packages, `dispatcher` (for types only).
- `capabilities/*` may **not** import from: `db` (use `ctx.db`), `sync` (use `ctx.transact`), `auth` (use `auth-service`), `api-server`, `mcp-server`, `apps/*` (CLI + Web UI SPA). Business logic lives in services, not handlers.
- Service packages (including `auth-service`) may import from: `ids`, `scopes`, `principal`, `db/repos`, infrastructure (`auth`, `sync`, `observability`), sibling service packages (sparingly, document in the import). May **not** import from: any surface package, `dispatcher`, `capabilities`.
- Repo packages (`db/repos/*`) may import from: `db` (Kysely) only. May **not** import services, capabilities, surfaces.
- Surface adapters may import from: `capabilities/registry`, `dispatcher`. Never services or repos directly.
- `auth` (infra) may import from: Better Auth primitives, `db` (to mount Kysely adapter). May **not** be imported by `capabilities` or any service layer except `auth-service`.

A PR that violates a layer rule fails the pre-commit lint.

### 16.3 Typed primitives

#### Branded IDs (`packages/ids`)

```ts
export type Branded<T, B> = T & { readonly __brand: B };
export type WorkspaceId  = Branded<string, "WorkspaceId">;
export type UserId       = Branded<string, "UserId">;
export type AgentId      = Branded<string, "AgentId">;
export type DocId        = Branded<string, "DocId">;
export type BlockId      = Branded<string, "BlockId">;
export type CollectionId = Branded<string, "CollectionId">;
export type CapabilityId = Branded<string, "CapabilityId">;
export type SessionId    = Branded<string, "SessionId">;
export type TokenId      = Branded<string, "TokenId">;
export type JobId        = Branded<string, "JobId">;
export type MirrorId         = Branded<string, "MirrorId">;         // F50
export type CustomDomainId   = Branded<string, "CustomDomainId">;   // F50
// parsers validate format (UUIDv7) and cast; single entry point per type
export const WorkspaceId = (s: string): WorkspaceId => { /* validate */ return s as WorkspaceId; };
// …etc
```

Handlers accept branded IDs, not `string`. Passing the wrong ID is a compile error.

#### String-literal unions

```ts
export type Scope = "doc:read" | "doc:write" | "doc:delete" | "doc:publish"
                  | "block:read" | "block:write"
                  | "comment:read" | "comment:write" | "comment:resolve"
                  | "search:read"
                  | "workspace:read" | "workspace:admin"
                  | "permission:grant" | "permission:revoke"
                  | "agent:create" | "agent:revoke"
                  | "admin";
export type CapabilityCategory = "mutation" | "read" | "auth" | "admin" | "system";
export type FidelityTier = "lossless" | "directive" | "opaque";
export type QueueName = "projection_blocks" | "embed" | "search_reindex"
                      | "mirror.project_doc" | "mirror.push" | "mirror.reconcile"
                      | "reaper" | "compaction" | "webhook" | "email"
                      | "dcr_cleanup" | "restore_search" | "purge"
                      | "outbox_forwarder";
export type PrincipalKind = "user" | "agent";
export type SubjectKind = "workspace" | "collection" | "doc" | "block"
                        | "comment" | "attachment" | "agent" | "user"
                        | "token" | "mirror" | "system";
```

Every `switch` on these is exhaustiveness-checked (`satisfies never` in the default arm).

#### Discriminated unions

```ts
export type Principal =
  | { kind: "user";  id: UserId;  workspace_id: WorkspaceId; roles: Role[];
      session_id: SessionId | null; token_id: TokenId | null }
  | { kind: "agent"; id: AgentId; workspace_id: WorkspaceId;
      owner_user_id: UserId | null; scopes: Scope[]; token_id: TokenId;
      token_kind: "agent-auth" | "api-key"; acting_as?: UserId };

// Canonical block post-state — what ends up in the blocks projection.
// NOT the Yjs binary update (that lives in doc_updates, invariant 3b).
export interface BlockPostState {
  id: BlockId;
  doc_id: DocId;
  type: string;
  parent_block_id: BlockId | null;
  order_key: string;
  content_json: unknown;
  visibility: "default" | "internal" | "public";
}

export interface DocPurgePreimage {
  doc_id: DocId;
  title: string;
  collection_id: CollectionId | null;
  visibility: "workspace" | "public" | "private";
  blocks: BlockPostState[];                // full block array at purge time
  snapshot_seq_at_purge: number;           // for forensics; the snapshot itself is gone
}

// AuditEffect carries everything needed to replay PersistentWorkspaceState
// (invariant 3a). See §9.1 / §9.2.
export type AuditEffect =
  // Lifecycle ---------------------------------------------------------------
  | { kind: "workspace.create"; workspace_id: WorkspaceId; slug: string; name: string; created_by: UserId }
  | { kind: "workspace.update"; workspace_id: WorkspaceId; patch: Partial<{ name: string; trash_retention_days: number; settings: unknown }> }
  | { kind: "workspace.soft_delete"; workspace_id: WorkspaceId }
  | { kind: "workspace.restore";     workspace_id: WorkspaceId }
  | { kind: "workspace.purge";       workspace_id: WorkspaceId; member_count_at_purge: number }
  | { kind: "member.add";    workspace_id: WorkspaceId; user_id: UserId; role: Role }
  | { kind: "member.remove"; workspace_id: WorkspaceId; user_id: UserId }
  | { kind: "member.update_role"; workspace_id: WorkspaceId; user_id: UserId; role: Role }
  // Collection --------------------------------------------------------------
  | { kind: "collection.create"; collection_id: CollectionId; workspace_id: WorkspaceId; parent_id: CollectionId | null; title: string; slug: string; order_key: string }
  | { kind: "collection.update"; collection_id: CollectionId; patch: Partial<{ title: string; slug: string; order_key: string }> }
  | { kind: "collection.move";   collection_id: CollectionId; new_parent_id: CollectionId | null; new_order_key: string }
  | { kind: "collection.soft_delete"; collection_id: CollectionId }
  | { kind: "collection.restore";     collection_id: CollectionId }
  // Doc ---------------------------------------------------------------------
  | { kind: "doc.create"; doc_id: DocId; workspace_id: WorkspaceId; collection_id: CollectionId | null; title: string; slug: string; order_key: string; visibility: "workspace"|"public"|"private"; seed_blocks: SeedBlock[] }  // seed_blocks = pre-minted BlockIds + shape for replay reconstruction (invariant 3a)
  | { kind: "doc.rename"; doc_id: DocId; title: string }
  | { kind: "doc.move";   doc_id: DocId; new_collection_id: CollectionId | null; new_order_key: string }
  | { kind: "doc.publish";   doc_id: DocId; published_at: number }
  | { kind: "doc.unpublish"; doc_id: DocId }
  | { kind: "doc.soft_delete"; doc_id: DocId }
  | { kind: "doc.restore";     doc_id: DocId }
  | { kind: "doc.purge"; preimage: DocPurgePreimage }        // full preimage for restore token + audit replay
  | { kind: "doc.reconcile_base_token"; doc_id: DocId; token: string; expires_at: number }  // F66/F73: transient; GC is auditable
  // Block (projection state; CRDT content is invariant 3b) ------------------
  | { kind: "block.insert"; doc_id: DocId; post: BlockPostState }
  | { kind: "block.update"; doc_id: DocId; post: BlockPostState }   // full post-state, not patch
  | { kind: "block.remove"; doc_id: DocId; block_id: BlockId }
  | { kind: "block.set_visibility"; doc_id: DocId; block_id: BlockId; visibility: "default"|"internal"|"public" }
  // doc.update batch (F12 + F33): one audit row per handler invocation ------
  | { kind: "doc.update_batch"; doc_id: DocId; ops: Array<
        | { op: "insert"; block: BlockPostState; after_block_id: BlockId | null; parent_block_id: BlockId | null }
        | { op: "update"; block_id: BlockId; post: BlockPostState }
        | { op: "move";   block_id: BlockId; new_parent_block_id: BlockId | null; new_order_key: string }
        | { op: "remove"; block_id: BlockId; preimage: BlockPostState }
        | { op: "set_visibility"; block_id: BlockId; visibility: "default"|"internal"|"public" }
      > }
  // Version -----------------------------------------------------------------
  | { kind: "version.create";  doc_id: DocId; version_id: string; name: string | null; snapshot_seq: number }
  | { kind: "version.restore"; doc_id: DocId; from_version_id: string; pre_restore_version_id: string; snapshot_seq_before: number; snapshot_seq_after: number }
  // Comment / attachment ----------------------------------------------------
  | { kind: "comment.create"; comment_id: string; doc_id: DocId; anchor: unknown; thread_root_id: string | null; body_markdown: string }
  | { kind: "comment.update"; comment_id: string; body_markdown: string }
  | { kind: "comment.resolve"; comment_id: string; resolved_by: UserId | AgentId }
  | { kind: "comment.soft_delete"; comment_id: string }
  | { kind: "attachment.request_upload"; upload_id: string; workspace_id: WorkspaceId; storage_key: string; declared_size: number; declared_content_type: string; declared_sha256: string | null; expires_at: number }   // F57/F80
  | { kind: "attachment.confirm_upload"; upload_id: string; attachment_id: string; storage_key: string; filename: string; content_type: string; bytes: number; sha256: string }                                         // F57/F80
  | { kind: "attachment.soft_delete"; attachment_id: string }
  // Permissions -------------------------------------------------------------
  | { kind: "acl.grant";  scope: { doc_id: DocId } | { collection_id: CollectionId }; subject_kind: "user"|"agent"|"role"; subject_id: string; access: "read"|"comment"|"edit"|"admin" }
  | { kind: "acl.revoke"; scope: { doc_id: DocId } | { collection_id: CollectionId }; subject_kind: "user"|"agent"|"role"; subject_id: string }
  // Principals --------------------------------------------------------------
  | { kind: "agent.create"; agent_id: AgentId; owner_user_id: UserId | null; name: string }
  | { kind: "agent.rename"; agent_id: AgentId; name: string }
  | { kind: "agent.revoke"; agent_id: AgentId }
  | { kind: "token.create"; token_id: TokenId; bound_to: { agent_id: AgentId } | { user_id: UserId }; scopes: Scope[]; expires_at: number | null }
  | { kind: "token.revoke"; token_id: TokenId }
  // Mirror ------------------------------------------------------------------
  | { kind: "mirror.configure"; patch: Partial<{ remote_url: string; branch: string; auth_kind: string; path_template: string; debounce_ms: number; batch_window_ms: number }> }
  | { kind: "mirror.enable";  }
  | { kind: "mirror.disable"; }
  | { kind: "mirror.reset_state"; mirror_id: MirrorId; workspace_id: WorkspaceId; cleared_state: true; reprojected: boolean; touched_credentials: false }   // F50 + F58
  | { kind: "mirror.reset_auth";  mirror_id: MirrorId; workspace_id: WorkspaceId; revoked_secret_ref: true; disabled: boolean; cleared_state: false }      // F58
  // Custom domain -----------------------------------------------------------
  | { kind: "custom_domain.add";    domain: string }
  | { kind: "custom_domain.verify"; custom_domain_id: CustomDomainId; verification_method: "dns" | "http" }   // F50: richer than old {domain}
  | { kind: "custom_domain.remove"; domain: string }
  // Webhooks (F56) ----------------------------------------------------------
  | { kind: "webhook.created";  webhook_id: string; workspace_id: WorkspaceId; url: string; events: string[]; resolved_ip: string }
  | { kind: "webhook.updated";  webhook_id: string; patch: Partial<{ url: string; events: string[]; active: boolean; resolved_ip: string; resolution_policy: "manual" | "auto_on_failure" }> }
  | { kind: "webhook.deleted";  webhook_id: string }
  | { kind: "webhook.rotated";  webhook_id: string; new_secret_version: number; dual_accept_until: number }
  | { kind: "webhook.circuit_broken"; webhook_id: string; failure_count: number; broken_at: number }
  | { kind: "webhook.test_delivery";  webhook_id: string; delivery_id: string; status: number | null; error: string | null }
  // Admin actions (F50) — replay is a no-op; enumerated for exhaustiveness --
  | { kind: "admin.reembed_workspace"; workspace_id: WorkspaceId; model_from: string; model_to: string }
  | { kind: "admin.reindex_workspace"; workspace_id: WorkspaceId; index_kind: "fts" | "hnsw" }
  | { kind: "admin.evict_doc";     doc_id: DocId }
  | { kind: "admin.unlock_doc";    doc_id: DocId }
  | { kind: "admin.job_requeue";   job_id: string; queue: string }
  | { kind: "admin.job_cancel";    job_id: string; queue: string }
  | { kind: "admin.queue_pause";   queue: string }
  | { kind: "admin.queue_resume";  queue: string }
  | { kind: "admin.secret_rotate"; secret_kind: string; dual_accept_until: number }
  | { kind: "admin.diagnose";      workspace_id: WorkspaceId; bundle_id: string; with_content: boolean };   // §9.7 bundle export
```

**Audit record envelope (F32).** Every persisted `audit_events` row is one of three variants:

```ts
export type AuditRecord =
  | { outcome: "allow"; effect: AuditEffect }
  | { outcome: "deny";  reason: DenyReason; effect: AuditDeny }
  | { outcome: "error"; error: HandlerError; effect: AuditError };

export type AuditDeny  = { kind: "deny";  capability: CapabilityId; required_scopes: Scope[]; reason_code: string };
export type AuditError = { kind: "error"; capability: CapabilityId; error_code: string; retriable: boolean };

// Supporting types used by effectOnDeny / effectOnError (§4.1):
export type DenyReason =
  | { kind: "missing_scope"; required: Scope[]; principal_scopes: Scope[] }
  | { kind: "cross_workspace" }
  | { kind: "human_only" }
  | { kind: "rate_limited"; bucket: string; retry_after_ms: number }
  | { kind: "acl_deny"; scope: { doc_id: DocId } | { collection_id: CollectionId } }
  | { kind: "sub_block_acl_not_implemented" };

export type HandlerError =
  | { kind: "validation"; issues: unknown }
  | { kind: "not_found"; subject_kind: SubjectKind; subject_id: string }
  | { kind: "conflict" }
  | { kind: "resource_limit"; detail: string }
  | { kind: "upstream"; service: string; status: number }
  | { kind: "internal"; trace_id: string };
```

Deny and error rows are emitted in an audit-only DB tx (no `doc_updates` row). The replay reducer for invariant 3a is a no-op for `deny`/`error` kinds; the `audit-effect-exhaustiveness` lint (§16.8) requires a branch for every variant even when the branch is empty.

**Collapse policy** (F2):

```ts
export type CollapsePolicy =
  | { collapsible: false }                         // all mutations
  | { collapsible: true; collapseKey: (input: unknown) => string; window_ms: 1000 };
```

Only `category = "read"` capabilities may set `collapsible: true`. Enforced by:

- A runtime assertion in dispatcher: mutation with `collapsible=true` throws at startup.
- A contract test: every capability where `category === "mutation"` asserts `collapsePolicy.collapsible === false`.

**JobPayload** (typed per queue):

```ts
export type JobPayload =
  | { queue: "projection_blocks"; doc_id: DocId; workspace_id: WorkspaceId; snapshot_seq: number }
  | { queue: "embed";             block_id: BlockId; workspace_id: WorkspaceId; model_version: number }
  | { queue: "search_reindex";    doc_id: DocId; workspace_id: WorkspaceId }
  | { queue: "mirror.project_doc"; doc_id: DocId; workspace_id: WorkspaceId; snapshot_seq: number }
  | { queue: "mirror.push";       workspace_id: WorkspaceId }
  | { queue: "mirror.reconcile";  workspace_id: WorkspaceId | null }      // null = all
  | { queue: "reaper";            batch: "doc_updates_tombstones" | "soft_delete_windows" | "attachments" | "orphan_uploads" | "reconcile_bases" }
  | { queue: "compaction";        doc_id: DocId; workspace_id: WorkspaceId }
  | { queue: "webhook";           webhook_id: string; event: string; payload: unknown }
  | { queue: "email";             to: string; template: string; data: unknown }
  | { queue: "dcr_cleanup" }
  | { queue: "restore_search";    doc_id: DocId; workspace_id: WorkspaceId }
  | { queue: "purge";             kind: "doc" | "workspace"; id: string; workspace_id: WorkspaceId }
  | { queue: "outbox_forwarder" };
```

The `kind` discriminants mean a fuzzer exhaustively generates every effect + payload shape, and the audit-replay reducer (invariant 3a) has one branch per `AuditEffect` kind — enforced by the `audit-effect-exhaustiveness` lint rule (§16.8).

### 16.4 `CapabilityContext` — the primitive every handler consumes

```ts
export interface CapabilityContext {
  readonly principal: Principal;                 // already authenticated
  readonly tenant: { workspace_id: WorkspaceId };// already resolved
  readonly db: TenantScopedDb;                   // scoped; un-scoped query is a compile error
  readonly transact: <T>(
    doc_id: DocId,
    fn: (editor: BlockNoteEditor<BlockSchema, InlineContentSchema, StyleSchema>) => T | Promise<T>
  ) => Promise<T>;                               // the only path to Y.Doc mutation; see §6
                                                 // F55: editor is BlockNoteEditor (exposes
                                                 // insertBlocks/updateBlock/removeBlocks);
                                                 // ServerBlockNoteEditor is a conversion
                                                 // surface without those methods (ADR 0018).
  readonly outbox: (
    event: string,
    payload: unknown
  ) => void;                                     // records an event in the write-path tx
                                                 // forwarder enqueues downstream jobs
  readonly logger: Logger;                       // pino w/ trace_id
  readonly tracer: Tracer;                       // OTel; use span() to nest
  readonly now: () => number;                    // injectable clock for tests
}
```

**What is explicitly absent:**

- **No `audit` writer.** Handlers do not write audit rows. The dispatcher writes them in the outer tx using `capability.audit.effectOnAllow(input, postState)` for accepted mutations, and `effectOnDeny` / `effectOnError` for denied / errored invocations (F3 + F32 fix — §6.2, §9.3). A handler that tried to write an audit row would have no way to do so.
- **No `jobs` enqueuer.** Handlers don't enqueue jobs directly. They emit events through `ctx.outbox(...)` so the row lands in the same tx as the `doc_updates` + `audit_events` write; a background forwarder will then read the outbox and call `JobService.enqueue` (transactional outbox pattern, F10 — §6.3). **Status as of 2026-04-21:** `ctx.outbox(...)` is wired transactionally at the trunk composition root — `packages/api-server/src/composition/createApiDispatcher.ts` (the non-test dispatcher composition) queues handler-emitted events during `fn(extras, auditTx)` and flushes them through `createOutboxWriter().append(auditTx, …)` before `withSystemTx` commits, inside the same `BEGIN IMMEDIATE` region as the capability's `ctx.db` writes, the `doc_updates` rows (content mutations only), and the dispatcher-written audit row. `doc.publish` and `doc.unpublish` are the first capabilities to exercise this seam: both emit `doc.visibility_changed` (§5.4, F5) with the post-update `visibility_version` as the invalidation key. Coverage pins this at two layers: `createApiDispatcher.integration.test.ts` nails the one-case allow / throw shapes, and the N-way fault-injection property test `packages/api-server/prop/metadata-only-atomicity.test.ts` (§17.1 row 7b) fuzzes atomicity across every in-tx query ordinal against the real factory (via a plugin-wrapped driver, not a mirrored fixture). The dispatcher-package's own unit/integration/property test fixtures under `packages/dispatcher/{src,prop}/` deliberately retain `ctx.outbox(...)` as a no-op stub — those tests verify dispatcher semantics in isolation, not trunk composition. The read-path `ctx.outbox` at `createApiDispatcher` throws a descriptive error (reads must not emit — capability bug surfaces loud). The dispatcher-emitted `outbox("doc.updated")` and `outbox("audit.appended")` rows continue to land in the same tx today (F31, verified by `packages/dispatcher/prop/writepath-atomicity.test.ts`).
- **No raw Kysely, no raw Hocuspocus, no `globalThis`, no `process.env`.** Config comes through the dispatcher-assembled context. Better Auth primitives are wrapped by `packages/auth-service` (§16.1 / F28). No direct HTTP request/response object reaches the handler.

Every handler signature is:

```ts
async function handler(ctx: CapabilityContext, input: I): Promise<O>
```

No `req`, no `res`, no `userId` positional arg, no `db` positional arg. The handler cannot cheat.

`ctx.transact` may be called **at most once per handler invocation**. This is asserted at runtime by the dispatcher; the planned `transact-called-at-most-once` rule in `@editorzero/arch-lint` will add a static backstop once the package ships (F89 — arch-lint is not yet implemented). Handlers that mutate across multiple docs must do so at the service layer across multiple capability invocations (typically via a job) — cross-doc atomicity is not a CRDT primitive.

### 16.5 `BlockTypeSpec` — the primitive every block type declares (ADR 0013)

`BlockTypeSpec` is the fidelity-tier descriptor editorzero carries per block type. **Do not confuse with BlockNote's own `BlockSpec` type (`{ config, implementation, extensions }` from `@blocknote/core`)** — different concern, colliding name; we renamed ours to avoid the collision at import sites.

```ts
import type {
  Block, BlockSchema, DefaultBlockSchema,
  DefaultInlineContentSchema, DefaultStyleSchema,
  InlineContentSchema, StyleSchema,
} from "@blocknote/core";
import type { RootContent } from "mdast";

export type MdastBlockNode = RootContent;

export interface BlockTypeSpec<
  Attrs extends Record<string, unknown>,
  BSchema extends BlockSchema = DefaultBlockSchema,
  ISchema extends InlineContentSchema = DefaultInlineContentSchema,
  SSchema extends StyleSchema = DefaultStyleSchema,
> {
  readonly type: string;                          // "editorzero:core/heading"
  readonly tier: FidelityTier;                    // lossless | directive | opaque
  readonly attributes: z.ZodType<Attrs>;
  readonly toMarkdown: (block: Block<BSchema, ISchema, SSchema>) => string;
  readonly fromMarkdown: (md: MdastBlockNode) => Block<BSchema, ISchema, SSchema> | null;
  readonly equivalence?: (
    a: Block<BSchema, ISchema, SSchema>,
    b: Block<BSchema, ISchema, SSchema>,
  ) => boolean;
  // reactView lives in `@editorzero/blocks/react` (requires @blocknote/react);
  // kept out of the kernel so the main export stays dep-light.
}
```

The property-test harness fuzzes every `BlockTypeSpec` against its declared tier contract. Registering a new block type auto-creates the fidelity test row.

### 16.6 Semantic naming

- **File path ↔ capability id.** `capabilities/src/<group>/<name>.ts` implements `"<group>.<name>"`. A tsmorph check at build asserts the mapping.
- **Repo per aggregate.** `db/repos/docs.ts` exports `docRepo`; `docs/foo.service.ts` imports `docRepo`. One aggregate per file.
- **Service functions read like the thing they do.** `publishDoc`, not `handleDocPublish`; `reconcileBlocks`, not `util1`.
- **Tests co-located with unit, separated by kind at package level.**
  - `foo.unit.test.ts` next to `foo.ts`.
  - `foo.integration.test.ts` under `packages/<pkg>/test/integration/`.
  - `foo.prop.test.ts` under `packages/<pkg>/test/prop/`.
  - Contract and E2E tests live in their own packages (`contract-tests`, `e2e`).

An agent can guess the path for any file type given the thing they want. No surprise routing.

### 16.7 Codegen inventory

| Artifact | Source of truth | Generator | Location | When | Committed? |
|---|---|---|---|---|---|
| Kysely DB types | Atlas `schema/*.sql` | `kysely-codegen` | `packages/db/src/generated/` | `pnpm codegen` | yes |
| Capability registry barrel | `capabilities/src/**/*.ts` | small bun script | `packages/capabilities/src/registry.ts` | build + watch | yes |
| OpenAPI spec | Capability zod schemas | `hono-openapi` at runtime (code-first; ADR 0029); snapshot via `pnpm openapi:snapshot` | `packages/api-server/openapi.snapshot.json` | CI on change | yes (snapshot); runtime otherwise |
| MCP tool list | Capability registry | `packages/mcp-server/src/create-mcp-handler.ts` (registry → tool loop at handler-factory time) | runtime | runtime | n/a |
| CLI command tree | Capability registry | `apps/cli/src/registry.ts` + `apps/cli/src/generator/` | runtime + frozen in `bun build --compile` | build | n/a (baked into binary) |
| Contract-test matrix | Capability registry | `packages/contract-tests/src/generate.ts` | `packages/contract-tests/generated/` | `pnpm test:contract` | yes |
| BlockNote schema | BlockSpecs registry | barrel | `packages/blocks/src/schema.ts` | build | yes |

Rule: **if it's derived, it's generated; if it's generated, it's committed (when feasible) or snapshot-compared**. Drift is a CI failure.

### 16.7a Runtime dependency pins (F24 fix)

Pins live in `package.json` + a `packages/pins/pins.json` registry used by CI to assert minimum versions and known-vulnerable ranges. The committed table:

| Dependency | Min version | Note | Source |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1` (not 2.x alpha) | Re-pin when 2.x GA | ADR 0009 |
| `better-auth` | `>=1.6.5` | GHSA-xr8f-h2gw-9xh6 fix | ADR 0010 |
| `@better-auth/sso` | latest ≥1.6.5 | SAML SLO + replay protection | ADR 0010 |
| `@better-auth/oauth-provider` | latest ≥1.6.5 | DCR + PKCE S256 | ADR 0010 |
| `@better-auth/mcp` | latest ≥1.6.5 | `withMcpAuth` / `mcpAuthHono` | ADR 0009/0010 |
| `@better-auth/api-key` | latest ≥1.6.5 | `referenceId` + `permissions` | ADR 0016 |
| `@better-auth/agent-auth` | `^1.5.6` **unstable** through 2026-H2 | Wrap behind Principal abstraction | ADR 0016 |
| `hono-openapi` (+ `@hono/standard-validator`) | pinned EXACT — ADR 0029 §7 fence (migration from `@hono/zod-openapi` pending) | Code-first route substrate + OpenAPI generator | ADR 0029 / §14 |
| `zod` | `^4` (StandardSchema-compatible) | Single schema across all surfaces | §4 / §16 |
| `hono` | latest LTS | Router under `/api` + `/mcp` | ADR 0002 |
| `@hocuspocus/server` | `3.4.4` (min) | Durability boundary notes apply | ADR 0006 |
| `yjs` | stable v13.x | CRDT core | ADR 0003 |
| `@blocknote/core`, `@blocknote/react` | latest stable | MPL-2.0 | ADR 0004 |
| `@blocknote/server-util` | latest stable | `ServerBlockNoteEditor` | ADR 0018 |
| `@blocknote/xl-*` | **not permitted in v1** | GPL-3.0, constrains commercial options (F25) | ADR 0004 / §19 Q1 |
| `kysely` | `^0.28` | Query builder | ADR 0007 |
| `kysely-codegen` | `^0.20` | Type generation from Atlas schema | ADR 0007 |
| `pg-boss` | latest stable | Postgres job queue | ADR 0014 |
| `pgvector` | `>=0.8.2` | CVE-2026-3172 fix | ADR 0008 |
| `sqlite-vec` | `^0.1.9` | Brute-force primary path | ADR 0008 |
| `remark-parse`, `remark-directive` | pinned (exact) | Markdown determinism; bump requires ADR 0013 harness re-run | ADR 0013 |
| `onnxruntime-node` | latest stable | Embedding runtime | ADR 0008 |
| `simple-git` | latest stable | Git mirror | ADR 0020 |
| `atlas` (CE) | Community build | `migrate lint` CE coverage | ADR 0007 |

CI step `pnpm pins:check` fails the build if `package.json` drops below any min or picks up a banned range.

### 16.8 Architecture lint rules

Target shape: a small set of Biome rules + a custom `@editorzero/arch-lint` package using `ts-morph`. The `arch-lint` package is not yet implemented (F89). The rule roster below is the v1 target; actual enforcement-today column distinguishes what is already gated vs. what is written-but-not-yet-bite.

| Rule | Enforcement today | Target home |
|---|---|---|
| `no-raw-kysely-outside-db` (F4) — `Kysely`, `sql<T>` raw importable only inside `packages/db/**` | **Enforced** by `scripts/coherence.ts` at pre-commit | `@editorzero/arch-lint` (ts-morph) |
| All other rules below | Not yet enforced — review + types + `scripts/coherence.ts`'s other checks are the backstop | `@editorzero/arch-lint` |

Target rule roster (all `@editorzero/arch-lint` except where noted):

- `forbidden-import-direction` — layer → layer matrix (see §16.2).
- `no-deep-import` — cross-package imports must go through `package/index.ts`.
- `capability-id-matches-path` — every `capabilities/<group>/<name>.ts` defines exactly one capability whose `id === "<group>.<name>"`.
- `no-raw-ydoc-access` — `Y.Doc`, `Y.XmlFragment`, etc. are only importable by `packages/sync/**`. Handlers use `ctx.transact`.
- `no-raw-kysely-outside-db` (F4) — `Kysely`, `sql<T>` raw, `db.connection()` importable only inside `packages/db/**`. **Currently enforced by coherence script**; will move to `@editorzero/arch-lint` when that package ships.
- `no-raw-kysely-in-capabilities` — `Kysely` is not importable from `packages/capabilities/**`. Handlers use `ctx.db` (`TenantScopedDb`).
- `ops-db-audit` (F4) — every `OpsDb` construction site requires an `@ops-audited("reason")` decorator and an entry in `ops/ops-db-registry.md`.
- `no-raw-audit-events-query` (F26) — direct Kysely access to `audit_events` is allowed only in `packages/db/repos/audit.ts`.
- `no-process-env` — config flows through a typed config object assembled at boot. Handlers don't read env.
- `audit-effect-exhaustiveness` — every `kind` in `AuditEffect` has a reducer branch in the audit-replay test.
- `json-normalization` — any JSON column has an adjacent `z.ZodType` + canonical-form serializer. Prevents silent schema drift.
- `no-blocknote-xl-in-v1` (F25) — `@blocknote/xl-*` packages are forbidden imports until the commercial-arm question resolves (brief §Open Q1 / ADR 0001).
- `transact-called-at-most-once` (F3) — static analysis of capability handlers: at most one lexical `ctx.transact(...)` call per handler; the dispatcher's runtime at-most-once backstop is what enforces the invariant today.
- `collapse-only-for-reads` (F2) — if `cap.category === "mutation"`, `cap.audit.collapsePolicy.collapsible` must be `false`.

Enforced rules today run at pre-commit and block the commit on violation. The rest are discipline-plus-review until the arch-lint package ships.

### 16.9 Test layout and naming

| Test kind | Where | Naming | Runs | Purpose |
|---|---|---|---|---|
| Unit | co-located | `<name>.unit.test.ts` | pre-commit (affected) | Pure logic, no I/O |
| Integration | `<pkg>/test/integration/` | `<name>.integration.test.ts` | pre-push (SQLite + Postgres matrix) | Real driver; repo layer + up |
| Property | `<pkg>/test/prop/` | `<name>.prop.test.ts` | pre-commit (short) + pre-push (full) + nightly (1M rounds for ADR 0013) | Invariants — CRDT convergence, fidelity, inverse-restore, audit replay, permission |
| Contract | `packages/contract-tests/` | generated, one per `(capability, surface)` | pre-push | Surface parity matrix |
| E2E | `packages/e2e/` | `<flow>.e2e.ts` | pre-push (fast), smoke-deploy (full) | Real browser + `@axe-core/playwright` WCAG 2.1 AA |
| Smoke | `ops/scripts/smoke.sh` | n/a | pre-push | `docker compose up`; hit `/health`, create a doc, teardown |
| Eval (search) | `packages/search/test/eval/` | `nDCG.eval.ts` | pre-push (10k corpus) + daily prod | nDCG@10 regression gate (ADR 0008) |

Shared fixtures: `packages/test-fixtures/` exports factory functions returning branded domain objects. No ad-hoc `{id: "test"}` anywhere.

**Golden test pattern:**

```ts
// packages/capabilities/src/doc/update.unit.test.ts
import { withCap } from "@editorzero/test-fixtures";
import { docUpdate } from "./update";

describe("doc.update", () => {
  it("applies block ops atomically", withCap(docUpdate, async ({ invoke, audit }) => {
    const out = await invoke({ doc_id, ops: [/*…*/] });
    expect(out).toMatchObject({ /*…*/ });
    expect(audit.last()).toMatchObject({
      capability_id: "doc.update",
      outcome: "allow",
      effect: { kind: "block.update", /*…*/ },
    });
  }));
});
```

`withCap` wires the dispatcher + a memory DB + a Hocuspocus stub + an in-memory audit writer. Every capability gets this for free.

### 16.10 Error primitives

```ts
export abstract class EditorZeroError extends Error {
  abstract readonly code: string;       // stable; surfaces map this
  abstract readonly httpStatus: number; // surface-agnostic; adapter uses it
  readonly fields?: Record<string, unknown>;  // structured context
}
export class PermissionDeniedError extends EditorZeroError { /* … */ }
export class ValidationError       extends EditorZeroError { /* … */ }
export class NotFoundError         extends EditorZeroError { /* … */ }
export class RateLimitError        extends EditorZeroError { /* … */ }
export class ConflictError         extends EditorZeroError { /* … */ }
export class ResourceLimitError    extends EditorZeroError { /* … */ }
export class UpstreamError         extends EditorZeroError { /* … */ }
export class InternalError         extends EditorZeroError { /* … */ }
```

Handlers throw typed errors. Each surface adapter has a single `mapError(err, surface)` pass that converts to HTTP status + RFC 9457 problem body (API), CLI exit code + stderr message, MCP protocol error, or UI `ActionResult`. Adapters never invent errors; they only map.

### 16.11 Observability primitives

- **Spans at layer boundaries**, not per function. Dispatcher emits one span per capability invocation; repo layer wraps queries in spans; mirror jobs, Hocuspocus handlers, MCP sessions all emit a canonical span.
- **Typed log events.** `logger.info({ event: "doc.published", doc_id, principal_id })` — `event` is a string-literal union (`LogEvent`) so grep/Loki queries resolve cleanly.
- **Span attributes are typed** via a helper (`attr.principal(p)` returns `{ "principal.kind": ..., "principal.id": ..., "principal.token_id": ... }`) — no string-key sprawl.
- **Every span carries `workspace_id`.** Per-tenant filtering is one query.

### 16.12 Secret management (F35)

All secrets flow through a typed config layer; `process.env` is never read directly by product code.

**Typed config.** `packages/config/secrets.ts` exports a discriminated union of secret sources:

```ts
export type SecretRef =
  | { mount: "file";  path: string }
  | { mount: "env";   env_var: string }
  | { mount: "vault"; vault_path: string };

export interface Secrets {
  BETTER_AUTH_SECRETS: SecretRef;
  S3_CREDENTIALS: SecretRef;
  SMTP_CREDENTIALS: SecretRef;
  OTLP_EXPORTER_AUTH: SecretRef;
  WEBHOOK_SIGNING_KEY: (workspace_id: WorkspaceId) => SecretRef;
  MIRROR_AUTH: (workspace_id: WorkspaceId, mirror_id: MirrorId) => SecretRef;
  KMS_MASTER_KEY: SecretRef;
}
```

Secrets split into two classes by rotation policy (F79):

- **Startup-only secrets** — DB connection strings, S3 endpoint, OTLP endpoint. Construction at boot reads the `SecretRef` once and caches the resolved value behind an interface; **rotation requires restart**. Handlers receive these via a `StartupSecretProvider` on dispatcher context.
- **Runtime-rotatable secrets** — `BETTER_AUTH_SECRETS`, per-workspace webhook signing keys, per-workspace mirror auth tokens, agent-token signing keys. These live behind a **versioned cache** keyed by `secret_version`. `admin.secret_rotate` publishes `secret_rotated:{secret_kind}:{new_version}` on Redis pub/sub (HA) or the in-process `EventBus` (single-node); each node invalidates its cached value and re-resolves on next use. The dual-accept window honors version `N-1` until retire time (see rotation sequence below). Handlers receive these via a `RotatableSecretProvider` on dispatcher context.

The split means a rotation of a webhook signing key takes effect in seconds across all nodes without restart; a DB-endpoint change still requires an operator-driven restart.

**At rest.** Secrets are encrypted with a **per-instance master key**. Master key sourced from:

- Single-node: OS secret store (libsecret / macOS Keychain / Windows Credential Manager).
- HA: operator-configured KMS hook via `KMS_URL` (AWS KMS / GCP KMS / HashiCorp Vault transit).

**`admin.secret_rotate` capability** (Appendix A) rotates:

- `BETTER_AUTH_SECRETS` (per ADR 0010 90-day schedule).
- Per-workspace webhook signing keys.
- Per-workspace mirror auth tokens.
- Agent-token signing keys.
- Diagnostic salts (per-workspace; F64).

Rotation sequence: (1) create new key with version `N+1`; (2) **dual-accept window** — both old (version `N`) and new (version `N+1`) keys valid for the full rotation window; publish `secret_rotated:{secret_kind}:{N+1}` on Redis pub/sub (HA) / in-process EventBus (single-node); each node invalidates its cached value and re-resolves; (3) retire old at end of window. Sessions signed under the old key are invalidated at the end of the dual-accept window via the revocation cascade (§10.3) — not abruptly on rotation start.

**Concurrency control (F79 + F60).** A second rotation on the same `secret_kind` while the previous dual-accept window is still open corrupts invariants (which version is "N-1"?). Rotation is serialized:

- **Postgres mode:** pg-boss `singletonKey = "secret_rotate:" + secret_kind + ":" + workspace_id` — duplicate rotations collapse.
- **SQLite mode:** DB advisory lock on the same key.
- Concurrent rotation requests that race the singleton → `ConflictError` with `retry_after_ms = dual-accept window remaining`.

Property test `concurrent-rotation.prop.ts` is listed explicitly in §17.1 invariant mapping (F60).

**Webhook HMAC signing.** Delivery headers:

- `X-EditorZero-Signature: v1=<hex(HMAC-SHA256(secret, "<timestamp>.<body>"))>`
- `X-EditorZero-Timestamp: <unix_ms>`
- Replay window: receivers reject timestamps > 5 min skew.
- **Canonical body (F62):** HMAC is computed over the **raw UTF-8 bytes of the HTTP POST body** before any JSON parse / transform. Verify-before-parse.

**Mirror auth.** Per-workspace token stored under `mirror_configs.auth_ref → secret_store://mirror/{workspace_id}/{mirror_id}`. Split operations (F58):
- `mirror.reset_state` — clears `mirror_state`, enqueues full re-projection; does NOT touch `auth_ref`.
- `mirror.reset_auth` — revokes the `auth_ref` secret and disables the mirror; does NOT clear `mirror_state`. Re-enabling requires a fresh `mirror.configure`.

Replay is unambiguous because each audit variant carries the boolean `cleared_state` / `touched_credentials` / `disabled` / `revoked_secret_ref` fields (§16.3).

**Gotcha surfaced to AGENTS.md:** "Never read secrets via `process.env` directly; always go through `packages/config/secrets.ts`." Enforced by the `no-process-env` lint rule (§16.8).

Property tests:

- `secret-rotation.prop.ts`: rotation invalidates old-key signatures at the end of the dual-accept window; both keys accepted during the window.
- `webhook-signature.prop.ts`: webhook signature verification rejects mangled bodies and timestamps outside the 5-min window.

### 16.13 Dev loop

```
pnpm dev              # apps/app + apps/admin on :3000/:3001, Hocuspocus embedded
pnpm test             # unit (affected), fast property, lint, types
pnpm test:full        # + integration (SQLite + Postgres), contract, property full, E2E, smoke
pnpm codegen          # Kysely types from Atlas, registry barrel, OpenAPI snapshot
pnpm migrate          # atlas migrate apply against local dev DB
pnpm format / lint    # Biome
pnpm openapi:snapshot # regenerate snapshot; CI compares
```

- **Pre-commit (fast, < 20s):** types, lint, format, unit-affected, fast-property-affected, schema drift.
- **Pre-push (complete, < 5min):** full pre-commit + integration + contract + E2E + smoke deploy + observability check.
- **Nightly (on a schedule if we ever add one):** 1M-round property fuzz (ADR 0013); longer eval corpus.
- **Affected-only** via `turbo run --filter` or `pnpm -r --filter "[HEAD^1]"`.

A pre-commit hook that's slow enough to cause friction is split, per AGENTS.md.

### 16.14 Capability versioning

- Adding a capability: non-breaking. Once the surface generators and contract-test matrix land, contract tests add a row and pre-commit fails until every type-compatible surface is generated.
- Changing a capability's **input** schema in a backward-incompatible way: ship `doc.update_v2`; mark old `deprecated: { since, sunset, replacement: "doc.update_v2" }`. Once the contract matrix lands, deprecated capabilities still pass contract tests until sunset; old MCP tools / OpenAPI routes / CLI subcommands emit a warning.
- Removing a capability: only after sunset. Once the contract matrix lands, contract tests confirm removal; migration notes in CHANGELOG.md.
- Renaming: forbidden. Add the new, deprecate the old. (Renames silently break clients.)

### 16.15 Working rules for a coding agent in this repo

These complement AGENTS.md's working rules:

1. **Start at the capability.** Every change begins at a capability in `packages/capabilities`. If no capability captures the intent, add one (with ADR if structural).
2. **Follow layer imports.** If the code you're writing wants to import across the arrow direction, the design is wrong. Refactor the layering or move the call.
3. **Derive, don't duplicate.** If you're about to hand-author a schema, check: does the registry already have it? Can you generate instead?
4. **Use `ctx.transact`.** Never `import { Hocuspocus }` in a capability handler. If the test for a doc mutation doesn't show a `transact` call, the code is wrong.
5. **Test at the smallest scope that proves the guarantee.** Pure logic → unit. Invariant → property. Cross-driver behavior → integration. Cross-surface parity → contract. User flow → E2E.
6. **Trust types.** If something's typed, don't add a runtime guard. If it can be typed but isn't, type it.
7. **No tactical comments.** Per CLAUDE.md global rules. A comment should explain a WHY that a reader of the current code can't see. "Used by X" belongs in the commit, not the file.
8. **Commit boundaries mirror capabilities.** One capability's addition or change per commit where possible. Contract tests land in the same commit.
9. **Pre-commit failure = design signal.** If a lint rule is in your way, fix the design, not the rule. Only amend rules via ADR-level discussion.
10. **When in doubt, write the property test first.** If you can state the guarantee, you can encode it. The test you write first is the test that doesn't regress silently later.

These rules are what keep four surfaces and a CRDT backbone from drifting as capabilities grow.
