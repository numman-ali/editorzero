/**
 * Capability dispatcher (architecture.md §6.1).
 *
 * The dispatcher is the single orchestration path between surface
 * adapters (API, CLI, MCP, UI) and capability handlers. It owns:
 *
 *  1. Input parsing (zod) — rejects with `ValidationError`.
 *  2. Permission gate — delegates to the injected `PermissionGate`.
 *     Deny → writes the `effectOnDeny` audit row, throws
 *     `PermissionDeniedError`.
 *  3. Handler invocation — supplies the capability its
 *     `CapabilityContext` via the injected `makeContextExtras` factory.
 *     Handlers may throw `PermissionDeniedError` for deny decisions
 *     the gate could not have made (sub-block ACL, ctx-aware
 *     quotas). The dispatcher recognises this as a first-class deny
 *     channel: it writes the `effectOnDeny` audit row with the
 *     handler's `DenyReason` and rethrows (F88). Handlers never
 *     touch the audit writer directly.
 *  4. Output parsing (zod) — rejects with `InternalError` (handler
 *     contract violation).
 *  5. Audit — writes the `effectOnAllow` / `effectOnError` row; the
 *     writer runs inside the write-path tx the caller owns (F31 — the
 *     concrete `@editorzero/db`-backed dispatcher will open it).
 *  6. Tracing — wraps everything in a `capability.invoke` span with
 *     standardised attributes.
 *
 * What this skeleton does NOT do yet (deferred to `@editorzero/db` +
 * `@editorzero/sync`):
 *  - Open the single write-path DB tx and commit
 *    `doc_updates + outbox(doc.updated) + audit_events + outbox(audit.appended)`
 *    atomically (F31).
 *  - Run the handler inside a Hocuspocus direct connection for content
 *    mutations (ADR 0018). `ctx.transact` is a caller-provided stub.
 *  - Per-principal / per-workspace rate limiting. The dispatcher stays
 *    rate-limit-agnostic by design: enforcement is the `withRateLimit`
 *    composition wrap in `@editorzero/api-server` (ADR 0044 Decision 6),
 *    which charges a token bucket and throws `RateLimitError` BEFORE the
 *    inner dispatch — so a 429 never enters this audit pipeline. A
 *    capability's `rateLimit` metadata is read by that wrap, not here.
 *  - AccessPath derivation from typed `doc_id` / `block_id` input
 *    fields. Callers pass the path in explicitly until the codegen
 *    step that synthesises it from the capability's zod input lands.
 *
 * **Type discipline:** no `as` casts, no `any`, no untyped field bags.
 * Error projection is owned by each `EditorZeroError` subclass via
 * `toHandlerError()` — the dispatcher calls that single method instead
 * of pattern-matching on string codes.
 */

import { createHash } from "node:crypto";

import type { AuditEffect, AuditRecord, AuditWriteInput, AuditWriter } from "@editorzero/audit";
import type { AnyCapability, CapabilityContext, Registry } from "@editorzero/capabilities";
import type { HandlerError } from "@editorzero/errors";
import {
  EditorZeroError,
  InternalError,
  PermissionDeniedError,
  TransactCalledTwiceError,
  ValidationError,
} from "@editorzero/errors";
import type { CapabilityId, DocId } from "@editorzero/ids";
import type { Logger, Tracer } from "@editorzero/observability";
import {
  type AccessPath,
  isAgent,
  isDelegated,
  type Principal,
  type TenantContext,
} from "@editorzero/principal";
import type { CapabilityCategory } from "@editorzero/scopes";

import type { PermissionGate } from "./gate";

// ── Dependency surface ─────────────────────────────────────────────────────

/**
 * Partial context factory — the dispatcher fills in `principal`,
 * `tenant`, `logger`, `tracer`, and `now`; the caller-provided
 * `makeContextExtras` supplies the IO-bound fields (`db`, `outbox`,
 * `transact`) that `@editorzero/db` + `@editorzero/sync` implement.
 * Keeping those behind a factory lets this package stay dep-light and
 * lets tests swap in in-memory fakes.
 */
export interface CapabilityContextExtras<TEditor = unknown> {
  readonly db: CapabilityContext<TEditor>["db"];
  readonly outbox: CapabilityContext<TEditor>["outbox"];
  readonly transact: CapabilityContext<TEditor>["transact"];
}

export interface DispatcherDeps<TEditor = unknown> {
  readonly registry: Registry<TEditor>;
  readonly gate: PermissionGate;
  readonly auditWriter: AuditWriter;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly now: () => number;
  /**
   * Run `fn` inside the write-path transaction (F31 / ADR 0018). The
   * impl opens a SQL tx, builds tx-scoped `CapabilityContextExtras`,
   * and hands the caller an `AuditTx` bound to the same tx. Commit on
   * resolve; rollback on throw.
   *
   * Called once per ALLOW-path invocation so handler DB writes + the
   * ALLOW audit INSERT land atomically. DENY / ERROR paths roll this
   * tx back and record their audit row via `withAuditTx` (separate,
   * short-lived tx) — otherwise the rollback would take the audit row
   * down with it.
   *
   * Tenant scope is derived from `principal.workspace_id`. There is
   * no separate `tenant` parameter so the impl cannot scope `db` to a
   * different workspace than the authorizing principal (F86).
   */
  readonly runInWriteTx: <T>(
    principal: Principal,
    fn: (extras: CapabilityContextExtras<TEditor>, auditTx: AuditTx) => Promise<T>,
  ) => Promise<T>;
  /**
   * Run `fn` for `category: "read"` capabilities — no SQL transaction.
   * The handler runs against a tenant-scoped read handle; the allow
   * audit row is written afterwards in a separate short-lived tx
   * (`withAuditTx`). Reads must not enter `runInWriteTx` because that
   * opens `BEGIN IMMEDIATE` and takes the SQLite RESERVED lock — it
   * would serialise concurrent writers against reads that don't
   * actually mutate state. Architecture §6.4's atomicity contract
   * applies to mutations; reads are allowed to proceed without a
   * writer lock.
   */
  readonly runRead: <T>(
    principal: Principal,
    fn: (extras: CapabilityContextExtras<TEditor>) => Promise<T>,
  ) => Promise<T>;
  /**
   * Open a short-lived audit-only transaction. Used on the paths where
   * the write-path tx either didn't open (input validation, gate deny,
   * read-path allow) or has already rolled back (handler error /
   * post-parse deny / output validation). Commits on resolve.
   */
  readonly withAuditTx: <T>(fn: (auditTx: AuditTx) => Promise<T>) => Promise<T>;
}

type AuditTx = Parameters<AuditWriter["write"]>[0];

export interface DispatchInvocation {
  readonly capability_id: CapabilityId;
  readonly input: unknown;
  readonly principal: Principal;
  /**
   * The AccessPath the dispatcher hands to the permission gate. Until
   * the codegen step that derives this from typed `doc_id` /
   * `block_id` fields lands, callers pass it in explicitly.
   *
   * `access.workspace_id` MUST equal `principal.workspace_id`. The
   * dispatcher asserts this at entry; mismatch is an adapter bug
   * (F86) and throws `TenantMismatchError` before any gate check or
   * db access.
   */
  readonly access: AccessPath;
  /**
   * OpenTelemetry trace id threaded into the audit row's `trace_id`
   * column for cross-system joins (§9.7). Null is acceptable for
   * tests and pre-instrumented CLI paths.
   */
  readonly trace_id: string | null;
}

/**
 * Thrown when an adapter submits a `DispatchInvocation` whose
 * `access.workspace_id` does not equal `principal.workspace_id`
 * (F86). This is structurally a caller bug — both fields are
 * independently supplied and nothing in the type system has forced
 * them to agree. The assertion fires before any gate or audit, so
 * the illegal invocation leaves no audit trail. Adapters are
 * responsible for deriving `access.workspace_id` from the principal.
 */
export class TenantMismatchError extends Error {
  override readonly name = "TenantMismatchError";
  readonly principal_workspace_id: string;
  readonly access_workspace_id: string;

  constructor(principal_workspace_id: string, access_workspace_id: string) {
    super(
      `access.workspace_id (${access_workspace_id}) does not match principal.workspace_id ` +
        `(${principal_workspace_id}); this is an adapter bug — derive access from principal.`,
    );
    this.principal_workspace_id = principal_workspace_id;
    this.access_workspace_id = access_workspace_id;
  }
}

export interface Dispatcher<TEditor = unknown> {
  readonly dispatch: (invocation: DispatchInvocation) => Promise<unknown>;
  readonly deps: DispatcherDeps<TEditor>;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Build the principal-dependent slice of `AuditWriteInput`. Uses the
 * `Principal` discriminant directly so `kind`, `session_id`, `token_id`
 * and `acting_as_user_id` are typed in both branches — no optional
 * chaining on a union, no casts.
 */
function principalFieldsFor(
  principal: Principal,
): Pick<
  AuditWriteInput,
  "principal_kind" | "principal_id" | "session_id" | "token_id" | "acting_as_user_id"
> {
  if (isAgent(principal)) {
    return {
      principal_kind: "agent",
      principal_id: principal.id,
      session_id: null,
      token_id: principal.token_id,
      acting_as_user_id: isDelegated(principal) ? principal.acting_as : null,
    };
  }
  return {
    principal_kind: "user",
    principal_id: principal.id,
    session_id: principal.session_id,
    token_id: principal.token_id,
    acting_as_user_id: null,
  };
}

/**
 * Recursively key-sort an unknown value into a form `JSON.stringify`
 * produces a canonical hash from. Pure structural narrowing via
 * `isPlainObject` — no casts, no `any`.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
  return sorted;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * SHA-256 hex over the canonicalised JSON (architecture.md §3.11 —
 * `input_hash TEXT NOT NULL  -- sha256 of normalized input`). Used for
 * de-dup inside the read-collapse window (ADR 0009) and for cross-service
 * joins after PII redaction. SHA-256 is cryptographic-grade not because
 * the audit log is a security trust anchor on its own, but because a
 * short non-crypto hash (the prior FNV-1a 32-bit form) collided often
 * enough at audit-volume that collapse-window queries were unsafe to
 * treat as identity.
 */
function stableHash(input: unknown): string {
  const json = JSON.stringify(canonicalize(input)) ?? "";
  return createHash("sha256").update(json).digest("hex");
}

function writeAudit<TEditor>(
  deps: DispatcherDeps<TEditor>,
  capability: AnyCapability<TEditor>,
  principal: Principal,
  tenant: TenantContext,
  record: AuditRecord,
  input: unknown,
  trace_id: string | null,
  duration_ms: number,
  auditTx: AuditTx,
): Promise<void> {
  const subject = capability.audit.subjectFrom(input);
  const writeInput: AuditWriteInput = {
    workspace_id: tenant.workspace_id,
    capability_id: capability.id,
    category: capability.category,
    ...principalFieldsFor(principal),
    subject_kind: subject.kind,
    subject_id: subject.id ?? null,
    input_hash: stableHash(input),
    duration_ms,
    trace_id,
    // Always 1 at write-time; read-collapse increments the *prior* row
    // inside the writer's tx (ADR 0009 / §9.3) when the collapse window
    // matches. Mutation capabilities can never collapse — that invariant
    // is enforced by the `collapse-only-for-reads` contract test.
    collapsed_count: 1,
    record,
  };
  return deps.auditWriter.write(auditTx, writeInput);
}

// ── Pipeline ──────────────────────────────────────────────────────────────

export function createDispatcher<TEditor = unknown>(
  deps: DispatcherDeps<TEditor>,
): Dispatcher<TEditor> {
  const dispatch = async (invocation: DispatchInvocation): Promise<unknown> => {
    const { capability_id, input, principal, access, trace_id } = invocation;

    // F86: tenant is not caller-supplied — it is derived from the
    // principal, which is the authorizing identity. `access.workspace_id`
    // is cross-checked against the principal before anything runs, so
    // Layer 1 and Layer 2 cannot disagree by construction.
    if (access.workspace_id !== principal.workspace_id) {
      throw new TenantMismatchError(principal.workspace_id, access.workspace_id);
    }
    const tenant: TenantContext = { workspace_id: principal.workspace_id };

    return deps.tracer.span("capability.invoke", async (span) => {
      span.setAttribute("capability.id", capability_id);
      span.setAttribute("principal.kind", principal.kind);
      span.setAttribute("workspace.id", tenant.workspace_id);

      const startedAt = deps.now();
      const capability = deps.registry.require(capability_id);
      span.setAttribute("capability.category", capability.category);

      // 1. Parse input
      //
      // Input-validation failures write a dispatcher-owned audit row
      // rather than calling `capability.audit.effectOnError` — the
      // capability's projections legitimately assume zod-validated
      // input (their `subjectFrom` / `effectOnError` signatures are
      // typed over the concrete `I`). Calling them with invalid input
      // would fail with a ZodError from inside the audit projection,
      // which is worse than recording a standard validation-error row.
      const parsedInput = capability.input.safeParse(input);
      if (!parsedInput.success) {
        const err = new ValidationError({
          message: "capability input validation failed",
          issues: parsedInput.error.issues,
        });
        await deps.withAuditTx((auditTx) =>
          writeInputValidationAudit(
            deps,
            capability.id,
            capability.category,
            principal,
            tenant,
            input,
            err,
            trace_id,
            startedAt,
            auditTx,
          ),
        );
        span.setAttribute("outcome", "error");
        span.recordError(err);
        throw err;
      }

      // 2. Permission gate
      const gateResult = await deps.gate.check(principal, capability, access);
      if (gateResult.outcome === "deny") {
        const duration_ms = deps.now() - startedAt;
        await deps.withAuditTx((auditTx) =>
          writeAudit(
            deps,
            capability,
            principal,
            tenant,
            {
              outcome: "deny",
              reason: gateResult.reason,
              effect: capability.audit.effectOnDeny(parsedInput.data, gateResult.reason),
            },
            parsedInput.data,
            trace_id,
            duration_ms,
            auditTx,
          ),
        );
        span.setAttribute("outcome", "deny");
        span.setAttribute("deny.reason", gateResult.reason.kind);
        throw new PermissionDeniedError({ reason: gateResult.reason });
      }

      // 3. Run handler + parse output.
      //
      // Two runner shapes, one branch point:
      //
      //   • `category: "read"` → `runRead`: no SQL tx opens. The
      //     handler runs against a tenant-scoped read handle; the
      //     allow audit is written afterwards in a separate
      //     short-lived tx (`withAuditTx`). Reads must not take the
      //     RESERVED lock `runInWriteTx` holds — §6.4's atomicity
      //     contract applies to mutations, not reads.
      //
      //   • anything else (mutation / auth / admin / system) →
      //     `runInWriteTx`: opens one `BEGIN IMMEDIATE` against the
      //     system DB (SQL-side of F31 / ADR 0018 §6.4) and commits
      //     handler `ctx.db` writes (metadata mirrors + later
      //     `doc_counters` / outbox rows) and the allow audit row
      //     atomically. If the handler throws, output parsing fails,
      //     or a post-parse `PermissionDeniedError` surfaces, the
      //     entire tx rolls back and the deny/error audit is
      //     recorded in a separate short-lived tx via `withAuditTx`
      //     — otherwise the rollback would also drop the audit row.
      //
      // Content mutations (capabilities that call `ctx.transact`)
      // are **not yet** atomic with this tx. Invariant 7 routes
      // CRDT writes through Hocuspocus; closing that atomicity
      // window is P3.6c's job — Hocuspocus's `onStoreDocument`
      // hook will run the Y.Doc persist inside this same SQL tx so
      // `doc_updates` + `audit_events` + `outbox` commit together.
      // Metadata-only mutations (`block.set_visibility`,
      // `doc.publish`, `collection.*`) are fully covered today.
      const buildCtx = (extras: CapabilityContextExtras<TEditor>): CapabilityContext<TEditor> => {
        // F92 runtime backstop: handlers must call `ctx.transact` at
        // most once per invocation (§16.4 + ADR 0018). The single-
        // write-path-tx contract (F31) depends on it — a second call
        // would split one logical mutation into two `doc_updates`
        // rows and two `outbox(doc.updated)` events, breaking
        // atomicity across CRDT, audit, and outbox. A dev-time
        // `@editorzero/arch-lint` rule will eventually catch this
        // syntactically; until then this wrapper throws on the
        // second call so the violation surfaces as a normal error
        // audit row instead of silently corrupting the write-path.
        let transactCalled = false;
        const transactOnce = async <T>(
          doc_id: DocId,
          fn: (editor: TEditor) => T | Promise<T>,
        ): Promise<T> => {
          if (transactCalled) {
            throw new TransactCalledTwiceError({ capability_id, doc_id });
          }
          transactCalled = true;
          return extras.transact(doc_id, fn);
        };
        return {
          principal,
          tenant: { workspace_id: tenant.workspace_id },
          db: extras.db,
          outbox: extras.outbox,
          transact: transactOnce,
          logger: deps.logger.child({
            event: "dispatcher.invoke",
            capability_id,
            principal_kind: principal.kind,
          }),
          tracer: deps.tracer,
          now: deps.now,
        };
      };

      const invokeAndParse = async (
        extras: CapabilityContextExtras<TEditor>,
      ): Promise<ReturnType<typeof capability.output.parse>> => {
        const ctx = buildCtx(extras);
        const rawOutput = await capability.invoke(ctx, parsedInput.data);
        const parsedOutput = capability.output.safeParse(rawOutput);
        if (!parsedOutput.success) {
          throw new InternalError({
            message: "capability output violated its schema",
            trace_id: trace_id ?? "",
          });
        }
        return parsedOutput.data;
      };

      try {
        if (capability.category === "read") {
          const output = await deps.runRead(principal, (extras) => invokeAndParse(extras));
          const duration_ms = deps.now() - startedAt;
          const effect: AuditEffect = capability.audit.effectOnAllow(parsedInput.data, output);
          await deps.withAuditTx((auditTx) =>
            writeAudit(
              deps,
              capability,
              principal,
              tenant,
              { outcome: "allow", effect },
              parsedInput.data,
              trace_id,
              duration_ms,
              auditTx,
            ),
          );
          span.setAttribute("outcome", "allow");
          span.setAttribute("duration_ms", duration_ms);
          return output;
        }

        return await deps.runInWriteTx(principal, async (extras, auditTx) => {
          const output = await invokeAndParse(extras);
          const duration_ms = deps.now() - startedAt;
          const effect: AuditEffect = capability.audit.effectOnAllow(parsedInput.data, output);
          await writeAudit(
            deps,
            capability,
            principal,
            tenant,
            { outcome: "allow", effect },
            parsedInput.data,
            trace_id,
            duration_ms,
            auditTx,
          );
          span.setAttribute("outcome", "allow");
          span.setAttribute("duration_ms", duration_ms);
          return output;
        });
      } catch (err) {
        // The write-path tx has rolled back. Record the audit in a
        // fresh short-lived tx so the outcome persists regardless.
        if (err instanceof PermissionDeniedError) {
          // F88 post-parse deny channel. Handlers throw
          // `PermissionDeniedError` for deny decisions that cannot be
          // made before the handler runs — sub-block ACL, quota state
          // tied to tenant reads, etc.
          const duration_ms = deps.now() - startedAt;
          await deps.withAuditTx((auditTx) =>
            writeAudit(
              deps,
              capability,
              principal,
              tenant,
              {
                outcome: "deny",
                reason: err.reason,
                effect: capability.audit.effectOnDeny(parsedInput.data, err.reason),
              },
              parsedInput.data,
              trace_id,
              duration_ms,
              auditTx,
            ),
          );
          span.setAttribute("outcome", "deny");
          span.setAttribute("deny.reason", err.reason.kind);
          throw err;
        }
        await deps.withAuditTx((auditTx) =>
          writeAuditError(
            deps,
            capability,
            principal,
            tenant,
            parsedInput.data,
            err,
            trace_id,
            startedAt,
            auditTx,
          ),
        );
        span.setAttribute("outcome", "error");
        span.recordError(err);
        throw err;
      }
    });
  };

  return { dispatch, deps };
}

/**
 * Project a thrown value to a `HandlerError` and emit the error audit
 * row. The projection is `err.toHandlerError()` for subclasses of
 * `EditorZeroError`; unknown thrown values get `{ kind: "internal" }`.
 * Adding a new `EditorZeroError` subclass forces a `toHandlerError`
 * implementation — no central switch stays in sync manually.
 *
 * Caller contract: `input` has been validated by `capability.input` —
 * the capability's typed audit projections are safe to call. For the
 * input-validation-failure path use `writeInputValidationAudit`.
 */
function writeAuditError<TEditor>(
  deps: DispatcherDeps<TEditor>,
  capability: AnyCapability<TEditor>,
  principal: Principal,
  tenant: TenantContext,
  input: unknown,
  err: unknown,
  trace_id: string | null,
  startedAt: number,
  auditTx: AuditTx,
): Promise<void> {
  const handlerErr: HandlerError =
    err instanceof EditorZeroError ? err.toHandlerError() : { kind: "internal", trace_id: "" };
  const duration_ms = deps.now() - startedAt;
  return writeAudit(
    deps,
    capability,
    principal,
    tenant,
    {
      outcome: "error",
      error: handlerErr,
      effect: capability.audit.effectOnError(input, handlerErr),
    },
    input,
    trace_id,
    duration_ms,
    auditTx,
  );
}

/**
 * Emit the audit row for input-validation failure. Uses a
 * capability-agnostic subject + effect because we cannot trust the
 * capability's typed projections on invalid input (they'd re-parse
 * and fail). Captures `capability_id` so operators can still query
 * "validation errors per capability" from `audit_events`.
 */
function writeInputValidationAudit<TEditor>(
  deps: DispatcherDeps<TEditor>,
  capability_id: CapabilityId,
  category: CapabilityCategory,
  principal: Principal,
  tenant: TenantContext,
  rawInput: unknown,
  err: ValidationError,
  trace_id: string | null,
  startedAt: number,
  auditTx: AuditTx,
): Promise<void> {
  const duration_ms = deps.now() - startedAt;
  const writeInput: AuditWriteInput = {
    workspace_id: tenant.workspace_id,
    capability_id,
    category,
    ...principalFieldsFor(principal),
    subject_kind: "system",
    subject_id: null,
    input_hash: stableHash(rawInput),
    duration_ms,
    trace_id,
    collapsed_count: 1,
    record: {
      outcome: "error",
      error: err.toHandlerError(),
      effect: {
        kind: "error",
        capability: capability_id,
        error_code: "validation_failed",
        retriable: false,
      },
    },
  };
  return deps.auditWriter.write(auditTx, writeInput);
}
