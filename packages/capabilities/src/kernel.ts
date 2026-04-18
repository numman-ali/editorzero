/**
 * Capability kernel — the contract every surface dispatches through
 * (architecture.md §4, §16.4).
 *
 * `Capability<I, O>` is the value each handler file exports. The registry
 * barrel (`registry.ts`, codegen) assembles them into a `Map<CapabilityId,
 * Capability>` that every adapter (API, CLI, MCP, UI) consumes — no
 * surface re-implements dispatch (invariant 5).
 *
 * `CapabilityContext` is the only thing a handler can touch. `ctx.db` is
 * tenant-scoped; `ctx.transact` is the sole path to CRDT mutations
 * (invariant 7 + ADR 0018); `ctx.outbox` records job events in the
 * write-path tx (F10 transactional-outbox); there is no `audit` writer —
 * the dispatcher writes audit rows from `capability.audit.effectOnAllow /
 * Deny / Error` (F3 + F32).
 *
 * `TEditor` is left as a generic parameter with default `unknown` so this
 * package stays dependency-light. `@editorzero/blocks` sharpens it to
 * `BlockNoteEditor<BSchema, ISchema, SSchema>` when handler code is
 * written (BlockNote's real tri-generic; the project schema is the
 * instance returned by `BlockNoteSchema.create({ blockSpecs })`). The
 * arch-lint rule `transact-called-at-most-once` backstops the invariant
 * that handlers invoke `ctx.transact` at most once per call (§16.8).
 */

import type {
  AuditDeny,
  AuditEffect,
  AuditError,
  CollapsePolicy,
  DenyReason,
  HandlerError,
} from "@editorzero/audit";
import type { CapabilityId, DocId, WorkspaceId } from "@editorzero/ids";
import type { Logger, Tracer } from "@editorzero/observability";
import type { Principal } from "@editorzero/principal";
import type { CapabilityCategory, Scope, SubjectKind, Surface } from "@editorzero/scopes";
import type { ZodType } from "zod";

// Re-export the structural contracts handlers consume so a capability
// file has one import source (`@editorzero/capabilities`) for context,
// not three.
export type { Logger, Tracer, TracerSpan } from "@editorzero/observability";

// ── Db handle — opaque brand ──────────────────────────────────────────────
//
// Concrete type is `TenantScopedDb` from `@editorzero/db`, assembled
// per-request by auth middleware. The kernel declares only the brand —
// handlers call methods on `ctx.db` typed in the concrete package.
// The arch-lint rule `no-raw-kysely-in-capabilities` enforces that
// handlers never reach past `ctx.db` for the raw driver.

export type TenantScopedDbHandle = { readonly __brand: "TenantScopedDb" };

// ── CapabilityContext (§16.4) ─────────────────────────────────────────────

export interface CapabilityContext<TEditor = unknown> {
  readonly principal: Principal;
  readonly tenant: { readonly workspace_id: WorkspaceId };
  readonly db: TenantScopedDbHandle;

  /**
   * The only path to Y.Doc mutation (invariant 7 + ADR 0018). Calls the
   * `fn` with a live `BlockNoteEditor` bound to the doc's Y.XmlFragment
   * inside a Hocuspocus direct connection transact. Must be called at
   * most once per handler invocation (§16.4).
   */
  readonly transact: <T>(doc_id: DocId, fn: (editor: TEditor) => T | Promise<T>) => Promise<T>;

  /**
   * Emits a job event in the write-path tx (F10 — transactional outbox).
   * The background forwarder reads the outbox and calls JobService.enqueue.
   */
  readonly outbox: (event: string, payload: unknown) => void;

  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly now: () => number;
}

// ── Capability<I, O> (§4.1) ───────────────────────────────────────────────

export interface AgentAllowance {
  readonly extraScopes?: readonly Scope[];
  readonly maxConcurrent?: number;
}

export interface RateLimit {
  readonly per: "principal" | "workspace" | "global";
  readonly bucket: string;
  readonly per_minute: number;
  readonly burst?: number;
}

export interface Deprecation {
  readonly since: string;
  readonly sunset: string;
  readonly replacement?: CapabilityId;
}

export interface CapabilityAudit<I, O> {
  readonly subjectFrom: (input: I) => { readonly kind: SubjectKind; readonly id?: string };
  readonly effectOnAllow: (input: I, output: O) => AuditEffect;
  readonly effectOnDeny: (input: I, reason: DenyReason) => AuditDeny;
  readonly effectOnError: (input: I, error: HandlerError) => AuditError;
  readonly collapsePolicy: CollapsePolicy;
}

export interface Capability<I, O, TEditor = unknown> {
  readonly id: CapabilityId;
  readonly category: CapabilityCategory;
  readonly summary: string;

  readonly input: ZodType<I>;
  readonly output: ZodType<O>;

  readonly requires: readonly Scope[];
  readonly humanOnly?: boolean;
  readonly agentAllowed?: AgentAllowance;

  readonly rateLimit?: RateLimit;

  readonly audit: CapabilityAudit<I, O>;
  readonly surfaces: readonly Surface[];
  readonly deprecated?: Deprecation;

  readonly handler: (ctx: CapabilityContext<TEditor>, input: I) => Promise<O>;
}

// Convenience alias for the registry barrel to hold an editor-uniform
// set of capabilities without each entry re-declaring the generic.
export type AnyCapability<TEditor = unknown> = Capability<unknown, unknown, TEditor>;
