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

import type { AnyCapability, Capability } from "./kernel";

/**
 * Shape of a compile-time registry map — keys are `CapabilityId`
 * literals, values are `Capability<I, O, TEditor>` with their exact
 * generics preserved. Produced by spreading the concrete capability
 * exports into an object literal and `as const`-ing it; consumers
 * typically interact through the `Registry` interface below rather
 * than this shape directly.
 */
export type CapabilityMap<TEditor = unknown> = {
  readonly [Id in CapabilityId]?: Capability<unknown, unknown, TEditor>;
};

export interface RegistryLookupError extends Error {
  readonly name: "RegistryLookupError";
  readonly capability_id: string;
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
 * Assemble a registry from a tuple of capability modules. Each
 * capability is indexed by its `id` field; duplicates throw at
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

  const sortedIds: readonly CapabilityId[] = Object.freeze(
    [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  const registry: Registry<TEditor> = {
    has: (id: CapabilityId) => byId.has(id),
    lookup: (id: CapabilityId) => byId.get(id),
    require: (id: CapabilityId) => {
      const cap = byId.get(id);
      if (cap === undefined) {
        const err = new Error(`Capability "${id}" not found in registry`) as Error & {
          capability_id: string;
        };
        err.name = "RegistryLookupError";
        err.capability_id = id;
        throw err;
      }
      return cap;
    },
    ids: () => sortedIds,
    list: () => Object.freeze(sortedIds.map((id) => byId.get(id) as AnyCapability<TEditor>)),
    entries: () =>
      Object.freeze(
        sortedIds.map(
          (id) =>
            Object.freeze([id, byId.get(id) as AnyCapability<TEditor>]) as readonly [
              CapabilityId,
              AnyCapability<TEditor>,
            ],
        ),
      ),
  };
  return Object.freeze(registry);
}
