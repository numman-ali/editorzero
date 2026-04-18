/**
 * Capability registry — the single lookup surface every adapter reads
 * from (architecture.md §4.3, §5.5). A registry is a frozen
 * `Map<CapabilityId, AnyCapability>` assembled once at process boot
 * from the concrete capability modules; API / CLI / MCP / UI surface
 * adapters iterate it to build route tables, command trees, MCP tool
 * definitions, and contract-matrix inputs. No surface re-implements
 * dispatch (invariant 5 + §5.5).
 *
 * The registry is intentionally read-only after construction. A
 * capability that wants to "register itself" imports the registry from
 * the barrel that composes it, it does not mutate the registry at
 * runtime. Codegen-time discovery (§16.7) is the supported path for
 * adding new capabilities; the duplicate-id assertion below is the
 * development guardrail that catches accidental double-registration
 * during a merge.
 *
 * Type-level note: `Registry<Map>` preserves the per-id type so a
 * consumer who knows the id statically gets the exact `Capability<I, O>`
 * back from `lookup`. Adapters that iterate blindly use `AnyCapability`
 * via `list` / `entries` and rely on runtime zod parsing for I/O.
 */

import type { CapabilityId } from "@editorzero/ids";

import type {
  AnyCapability,
  Capability,
  CapabilityAudit,
  CapabilityContext,
  RegisteredCapability,
} from "./kernel";

/**
 * Thrown by `Registry.require` when an id is absent. Subclasses `Error`
 * so `instanceof RegistryLookupError` narrows cleanly in catch blocks —
 * no structural-type assertions at call sites.
 */
export class RegistryLookupError extends Error {
  override readonly name = "RegistryLookupError";
  readonly capability_id: string;

  constructor(capability_id: string) {
    super(`Capability "${capability_id}" not found in registry`);
    this.capability_id = capability_id;
  }
}

/**
 * Read-only registry handle. Implementations are produced by
 * `createRegistry`; the adapters only ever see this interface so a
 * future registry that sources capabilities from disk (codegen
 * artefact, plugin manifest) drops in without touching adapter code.
 */
export interface Registry<TEditor = unknown> {
  readonly has: (id: CapabilityId) => boolean;
  /**
   * Returns the capability or `undefined`. Callers that treat a miss as
   * a programming error should use `require` instead.
   */
  readonly lookup: (id: CapabilityId) => AnyCapability<TEditor> | undefined;
  /**
   * Returns the capability or throws `RegistryLookupError`. Use when
   * the id has been validated (e.g. by a route table built from the
   * same registry) and a miss would be a bug.
   */
  readonly require: (id: CapabilityId) => AnyCapability<TEditor>;
  /** All capability ids, sorted lexicographically for deterministic output. */
  readonly ids: () => readonly CapabilityId[];
  /** All capabilities, in the same order as `ids()`. */
  readonly list: () => readonly AnyCapability<TEditor>[];
  /** Paired id/capability tuples, matching `ids()` / `list()` order. */
  readonly entries: () => readonly (readonly [CapabilityId, AnyCapability<TEditor>])[];
}

/**
 * Wrap a typed `Capability<I, O, TEditor>` into the heterogeneous
 * `RegisteredCapability<TEditor>` shape the registry stores and the
 * dispatcher consumes. The typed `I` / `O` live inside the closure:
 * `invoke` receives pre-validated input as `unknown` and delegates to
 * the concrete `handler(ctx, input)`; the `audit` projections are
 * re-wrapped so each receives typed values while exposing the
 * `CapabilityAudit<unknown, unknown>` surface to the dispatcher.
 *
 * This is the one necessary narrowing at the registration boundary —
 * but it happens with the concrete `I` / `O` still visible to TS
 * inside the closure, so no `as` casts leak. The dispatcher calls
 * `invoke` with an input that it has already validated through
 * `this.input`, so the zod re-parse inside `invoke` would be
 * redundant; callers rely on that contract.
 */
export function registerCapability<I, O, TEditor = unknown>(
  capability: Capability<I, O, TEditor>,
): RegisteredCapability<TEditor> {
  const invoke = async (
    ctx: CapabilityContext<TEditor>,
    validatedInput: unknown,
  ): Promise<unknown> => {
    // Validated by the dispatcher against `capability.input`; the parse
    // result below turns `unknown` into the concrete `I` without a
    // cast. If the dispatcher's contract is violated (invoke called
    // with unvalidated input), `parse` throws a ZodError — caller's bug.
    const typedInput: I = capability.input.parse(validatedInput);
    const output: O = await capability.handler(ctx, typedInput);
    return output;
  };

  const audit: CapabilityAudit<unknown, unknown> = {
    subjectFrom: (input) => capability.audit.subjectFrom(capability.input.parse(input)),
    effectOnAllow: (input, output) =>
      capability.audit.effectOnAllow(
        capability.input.parse(input),
        capability.output.parse(output),
      ),
    effectOnDeny: (input, reason) =>
      capability.audit.effectOnDeny(capability.input.parse(input), reason),
    effectOnError: (input, error) =>
      capability.audit.effectOnError(capability.input.parse(input), error),
    collapsePolicy: capability.audit.collapsePolicy,
  };

  const registered: RegisteredCapability<TEditor> = {
    id: capability.id,
    category: capability.category,
    summary: capability.summary,
    input: capability.input,
    output: capability.output,
    requires: capability.requires,
    ...(capability.humanOnly !== undefined && { humanOnly: capability.humanOnly }),
    ...(capability.agentAllowed !== undefined && { agentAllowed: capability.agentAllowed }),
    ...(capability.rateLimit !== undefined && { rateLimit: capability.rateLimit }),
    audit,
    surfaces: capability.surfaces,
    ...(capability.deprecated !== undefined && { deprecated: capability.deprecated }),
    invoke,
  };
  return registered;
}

/**
 * Assemble a registry from a list of registered capability modules.
 * Each capability is indexed by its `id` field; duplicates throw at
 * construction time (covers the merge-collision case that contract
 * tests would also catch post-hoc). Output is frozen.
 */
export function createRegistry<TEditor = unknown>(
  capabilities: readonly AnyCapability<TEditor>[],
): Registry<TEditor> {
  const byId = new Map<CapabilityId, AnyCapability<TEditor>>();

  for (const cap of capabilities) {
    if (byId.has(cap.id)) {
      throw new Error(
        `Duplicate capability id "${cap.id}" registered. ` +
          `Capabilities must have unique ids; the second registration is a merge-time mistake.`,
      );
    }
    byId.set(cap.id, cap);
  }

  // Build the sorted pair list once. `Map.entries()` preserves the
  // value type so no lookup-and-narrow dance (and no cast) is needed
  // downstream.
  const sortedEntries: readonly (readonly [CapabilityId, AnyCapability<TEditor>])[] = Object.freeze(
    [...byId.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map((entry) => Object.freeze(entry)),
  );
  const sortedIds: readonly CapabilityId[] = Object.freeze(sortedEntries.map(([id]) => id));
  const sortedCaps: readonly AnyCapability<TEditor>[] = Object.freeze(
    sortedEntries.map(([, cap]) => cap),
  );

  const registry: Registry<TEditor> = {
    has: (id: CapabilityId) => byId.has(id),
    lookup: (id: CapabilityId) => byId.get(id),
    require: (id: CapabilityId) => {
      const cap = byId.get(id);
      if (cap === undefined) throw new RegistryLookupError(id);
      return cap;
    },
    ids: () => sortedIds,
    list: () => sortedCaps,
    entries: () => sortedEntries,
  };
  return Object.freeze(registry);
}
