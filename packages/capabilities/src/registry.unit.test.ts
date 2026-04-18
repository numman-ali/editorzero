import { CapabilityId } from "@editorzero/ids";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Capability } from "./kernel";
import { createRegistry, RegistryLookupError, registerCapability } from "./registry";

/**
 * Minimum-viable registered capability for registry tests. None of the
 * runtime behaviour is exercised — the registry only reads `id` — but
 * the object goes through `registerCapability(typedCapability)` so any
 * drift on `Capability<I, O>`'s shape surfaces at author time, not at
 * dispatch time. No casts.
 */
function stubCapability(id: string) {
  const typed: Capability<Record<string, never>, Record<string, never>> = {
    id: CapabilityId(id),
    category: "read",
    summary: `stub capability ${id}`,
    input: z.object({}).strict(),
    output: z.object({}).strict(),
    requires: [],
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
    surfaces: ["api"],
    handler: async () => ({}),
  };
  return registerCapability(typed);
}

describe("createRegistry", () => {
  it("exposes capabilities by id", () => {
    const registry = createRegistry([stubCapability("doc.create"), stubCapability("doc.read")]);

    expect(registry.has(CapabilityId("doc.create"))).toBe(true);
    expect(registry.lookup(CapabilityId("doc.read"))?.id).toBe("doc.read");
    expect(registry.require(CapabilityId("doc.create")).summary).toContain("doc.create");
  });

  it("returns undefined for unknown ids via lookup", () => {
    const registry = createRegistry([stubCapability("doc.create")]);
    expect(registry.lookup(CapabilityId("doc.read"))).toBeUndefined();
  });

  it("throws RegistryLookupError for unknown ids via require", () => {
    const registry = createRegistry([stubCapability("doc.create")]);
    expect(() => registry.require(CapabilityId("doc.read"))).toThrowError(/not found/);

    try {
      registry.require(CapabilityId("doc.read"));
      expect.fail("expected require to throw");
    } catch (err) {
      // `instanceof` narrows `err: unknown` to `RegistryLookupError`
      // without casts — the subclass carries typed fields.
      expect(err).toBeInstanceOf(RegistryLookupError);
      if (err instanceof RegistryLookupError) {
        expect(err.name).toBe("RegistryLookupError");
        expect(err.capability_id).toBe("doc.read");
      }
    }
  });

  it("returns ids sorted lexicographically for deterministic output", () => {
    const registry = createRegistry([
      stubCapability("workspace.create"),
      stubCapability("doc.create"),
      stubCapability("doc.read"),
    ]);
    expect(registry.ids()).toEqual(["doc.create", "doc.read", "workspace.create"]);
  });

  it("aligns list() / entries() with ids() order", () => {
    const registry = createRegistry([
      stubCapability("workspace.create"),
      stubCapability("doc.create"),
    ]);
    const ids = registry.ids();
    const listIds = registry.list().map((c) => c.id);
    const entryIds = registry.entries().map(([id]) => id);
    expect(listIds).toEqual(ids);
    expect(entryIds).toEqual(ids);
  });

  it("throws on duplicate capability ids", () => {
    expect(() =>
      createRegistry([stubCapability("doc.create"), stubCapability("doc.create")]),
    ).toThrowError(/Duplicate capability id/);
  });

  it("is frozen after construction", () => {
    const registry = createRegistry([stubCapability("doc.create")]);
    expect(Object.isFrozen(registry)).toBe(true);
  });
});

// ── Registered wrapper execution ─────────────────────────────────────────
//
// `registerCapability` folds a typed `Capability<I, O>` into a
// heterogeneous `RegisteredCapability` by wrapping the handler and the
// four audit projections in closures that re-parse via the declared
// zod schemas. The dispatcher invokes these wrappers at runtime, but
// the shape is a contract of the capabilities package — the wrapper
// must actually round-trip input through `capability.input.parse`
// and output through `capability.output.parse`, and the audit
// projections must be reachable.

describe("registerCapability wrappers", () => {
  interface Input {
    readonly name: string;
  }
  interface Output {
    readonly greeting: string;
  }

  // Record the values each projection sees, so we can assert the wrapper
  // actually re-parsed input + output before calling us. Tests populate
  // this via the capability factory's closures.
  interface SeenBySpy {
    subject: Input | null;
    allowInput: Input | null;
    allowOutput: Output | null;
    denyInput: Input | null;
    errorInput: Input | null;
  }

  function greetCapability(spy?: SeenBySpy): Capability<Input, Output> {
    return {
      id: CapabilityId("greet.hello"),
      category: "read",
      summary: "greet the caller",
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      requires: [],
      audit: {
        subjectFrom: (input) => {
          if (spy) spy.subject = input;
          return { kind: "workspace", id: input.name };
        },
        effectOnAllow: (input, output) => {
          if (spy) {
            spy.allowInput = input;
            spy.allowOutput = output;
          }
          return { kind: "audit.access_log" };
        },
        effectOnDeny: (input, reason) => {
          if (spy) spy.denyInput = input;
          return {
            kind: "deny",
            capability: CapabilityId("greet.hello"),
            required_scopes: [],
            reason_code: `${reason.kind}:${input.name}`,
          };
        },
        effectOnError: (input, error) => {
          if (spy) spy.errorInput = input;
          return {
            kind: "error",
            capability: CapabilityId("greet.hello"),
            error_code: `${error.kind}:${input.name}`,
            retriable: false,
          };
        },
        collapsePolicy: { collapsible: false },
      },
      surfaces: ["api"],
      handler: async (_ctx, input) => ({ greeting: `hello ${input.name}` }),
    };
  }

  function freshSpy(): SeenBySpy {
    return {
      subject: null,
      allowInput: null,
      allowOutput: null,
      denyInput: null,
      errorInput: null,
    };
  }

  it("invoke() re-parses input, runs the handler, returns the output", async () => {
    const registered = registerCapability(greetCapability());
    // CapabilityContext is typed — we feed a minimal stub because the
    // greet handler never reads from it.
    const ctx = {} as Parameters<typeof registered.invoke>[0];
    const out = await registered.invoke(ctx, { name: "Nomi" });
    expect(out).toEqual({ greeting: "hello Nomi" });
  });

  it("invoke() rejects untyped input that violates the declared schema", async () => {
    const registered = registerCapability(greetCapability());
    const ctx = {} as Parameters<typeof registered.invoke>[0];
    // A caller that bypasses the dispatcher parse-gate would hit this
    // safeguard — registered.invoke re-parses so the handler's typed
    // contract is never violated.
    await expect(registered.invoke(ctx, { name: 123 })).rejects.toThrow();
  });

  it("audit.subjectFrom re-parses input before projecting", () => {
    const spy = freshSpy();
    const registered = registerCapability(greetCapability(spy));
    const subject = registered.audit.subjectFrom({ name: "Nomi" });
    expect(subject.kind).toBe("workspace");
    expect(subject.id).toBe("Nomi");
    expect(spy.subject).toEqual({ name: "Nomi" });
  });

  it("audit.effectOnAllow re-parses both input and output", () => {
    const spy = freshSpy();
    const registered = registerCapability(greetCapability(spy));
    const effect = registered.audit.effectOnAllow({ name: "Nomi" }, { greeting: "hello Nomi" });
    expect(effect.kind).toBe("audit.access_log");
    expect(spy.allowInput).toEqual({ name: "Nomi" });
    expect(spy.allowOutput).toEqual({ greeting: "hello Nomi" });
  });

  it("audit.effectOnDeny re-parses input and threads the deny reason", () => {
    const registered = registerCapability(greetCapability());
    const effect = registered.audit.effectOnDeny({ name: "Nomi" }, { kind: "human_only" });
    expect(effect.kind).toBe("deny");
    if (effect.kind === "deny") {
      expect(effect.reason_code).toBe("human_only:Nomi");
    }
  });

  it("audit.effectOnError re-parses input and threads the handler error", () => {
    const registered = registerCapability(greetCapability());
    const effect = registered.audit.effectOnError(
      { name: "Nomi" },
      { kind: "internal", trace_id: "" },
    );
    expect(effect.kind).toBe("error");
    if (effect.kind === "error") {
      expect(effect.error_code).toBe("internal:Nomi");
    }
  });

  it("preserves the capability's collapsePolicy verbatim", () => {
    const registered = registerCapability(greetCapability());
    expect(registered.audit.collapsePolicy.collapsible).toBe(false);
  });

  it("propagates every optional capability field when present", () => {
    const cap = greetCapability();
    // Feed the full optional envelope so the conditional-spread branches
    // in registerCapability (humanOnly / agentAllowed / rateLimit /
    // deprecated) all fire.
    const agentAllowed = {
      extraScopes: ["doc:read"] as const,
      maxConcurrent: 2,
    };
    const rateLimit = {
      per: "principal",
      bucket: "greet",
      per_minute: 60,
    } as const;
    const deprecated = {
      since: "v1",
      sunset: "v2",
      replacement: CapabilityId("greet.hello_v2"),
    };
    const registered = registerCapability({
      ...cap,
      humanOnly: true,
      agentAllowed,
      rateLimit,
      deprecated,
    });
    expect(registered.humanOnly).toBe(true);
    expect(registered.agentAllowed).toEqual(agentAllowed);
    expect(registered.rateLimit).toEqual(rateLimit);
    expect(registered.deprecated).toEqual(deprecated);
  });
});
