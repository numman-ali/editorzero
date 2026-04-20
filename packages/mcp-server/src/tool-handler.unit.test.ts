import type { Capability } from "@editorzero/capabilities";
import { registerCapability } from "@editorzero/capabilities";
import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { NotFoundError, PermissionDeniedError, ValidationError } from "@editorzero/errors";
import { CapabilityId, UserId, WorkspaceId } from "@editorzero/ids";
import type { Principal, UserPrincipal } from "@editorzero/principal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runTool } from "./tool-handler";

function makeCap(id = "doc.list") {
  const typed: Capability<Record<string, never>, Record<string, never>> = {
    id: CapabilityId(id),
    category: "read",
    summary: `stub ${id}`,
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
    surfaces: ["mcp"],
    handler: async () => ({}),
  };
  return registerCapability(typed);
}

function makePrincipal(): UserPrincipal {
  return {
    kind: "user",
    id: UserId("018f0000-0000-7000-8000-000000000a01"),
    workspace_id: WorkspaceId("018f0000-0000-7000-8000-000000000b01"),
    roles: ["member"],
    session_id: null,
    token_id: null,
  };
}

function makeDispatcher(dispatch: Dispatcher["dispatch"]): Dispatcher {
  return { dispatch, deps: {} as Dispatcher["deps"] };
}

describe("runTool", () => {
  let principal: Principal;

  beforeEach(() => {
    principal = makePrincipal();
  });

  it("dispatches the capability with access.workspace_id derived from principal", async () => {
    const dispatch = vi.fn<Dispatcher["dispatch"]>(async () => ({ ok: true }));
    const dispatcher = makeDispatcher(dispatch);
    const capability = makeCap("doc.list");

    await runTool({ capability, input: { foo: "bar" }, principal, dispatcher });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0]?.[0] as DispatchInvocation;
    expect(call.capability_id).toBe(capability.id);
    expect(call.input).toEqual({ foo: "bar" });
    expect(call.principal).toBe(principal);
    expect(call.access.workspace_id).toBe(principal.workspace_id);
    expect(call.trace_id).toBeNull();
  });

  it("returns the dispatch output as JSON text on success", async () => {
    const dispatcher = makeDispatcher(async () => ({ doc_id: "d_123", title: "hello" }));
    const capability = makeCap();

    const result = await runTool({ capability, input: {}, principal, dispatcher });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ doc_id: "d_123", title: "hello" }) },
    ]);
    expect(result.structuredContent).toBeUndefined();
  });

  it("maps ValidationError to isError + structured error envelope", async () => {
    const dispatcher = makeDispatcher(async () => {
      throw new ValidationError({ issues: [{ path: ["title"], message: "required" }] });
    });
    const capability = makeCap();

    const result = await runTool({ capability, input: {}, principal, dispatcher });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "validation failed" });
    expect(result.structuredContent).toEqual({
      error: { code: "validation_failed", message: "validation failed" },
    });
  });

  it("maps PermissionDeniedError to isError + structured error envelope", async () => {
    const dispatcher = makeDispatcher(async () => {
      throw new PermissionDeniedError({
        reason: { kind: "missing_scope", required: ["doc:write"], principal_scopes: [] },
      });
    });
    const capability = makeCap();

    const result = await runTool({ capability, input: {}, principal, dispatcher });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "permission_denied" },
    });
  });

  it("maps NotFoundError to isError + structured error envelope", async () => {
    const dispatcher = makeDispatcher(async () => {
      throw new NotFoundError({ subject_kind: "doc", subject_id: "d_missing" });
    });
    const capability = makeCap();

    const result = await runTool({ capability, input: {}, principal, dispatcher });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("rethrows non-EditorZeroError throws so the SDK handles them (ADR 0026 commitment 4)", async () => {
    const dispatcher = makeDispatcher(async () => {
      throw new Error("unexpected boom");
    });
    const capability = makeCap();

    await expect(runTool({ capability, input: {}, principal, dispatcher })).rejects.toThrow(
      "unexpected boom",
    );
  });

  it("rethrows non-Error throws (e.g., string) unchanged", async () => {
    const dispatcher = makeDispatcher(async () => {
      throw "not-an-error-object";
    });
    const capability = makeCap();

    await expect(runTool({ capability, input: {}, principal, dispatcher })).rejects.toBe(
      "not-an-error-object",
    );
  });
});
