/**
 * Reducer unit tests — pure typed fixtures (no DB, no dispatcher).
 *
 * These prove the effect→state contract in isolation:
 *   - every `"state"`-classed kind has a real transition (the per-kind
 *     gate — a kind classified `"state"` without a transition would hit
 *     `applyStateEffect`'s `default` throw and fail here);
 *   - deny/error rows and every non-`"state"` class are no-ops;
 *   - patches to absent entities are safe (truncated-log resilience);
 *   - `REPLAY_CLASS` partitions all kinds into the four classes.
 *
 * The *integration* proof — that the audit log a real dispatcher emits
 * reconstructs the live DB — lives in the dispatcher package's property
 * suite; this file is the unit-level backstop.
 */

import { CapabilityId, CollectionId, DocId, UserId, WorkspaceId } from "@editorzero/ids";
import { describe, expect, it } from "vitest";
import type { AuditEffect } from "./effect";
import { applyAuditRow, REPLAY_CLASS, replay } from "./reducer";
import { EMPTY_STATE, memberKey, type ReplayRow } from "./state";

const WS = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER = UserId("018f0000-0000-7000-8000-000000000002");
const USER2 = UserId("018f0000-0000-7000-8000-000000000003");
const COLL = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const COLL2 = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const DOC = DocId("018f0000-0000-7000-8000-0000000000d1");

function allow(effect: AuditEffect, principal_id: string = USER): ReplayRow {
  return { principal_kind: "user", principal_id, record: { outcome: "allow", effect } };
}

describe("replay reducer — state transitions", () => {
  it("reconstructs the metadata spine from a representative log", () => {
    const state = replay([
      allow({
        kind: "workspace.create",
        workspace_id: WS,
        slug: "acme",
        name: "Acme",
        created_by: USER,
      }),
      allow({ kind: "member.add", workspace_id: WS, user_id: USER, role: "owner" }),
      allow({ kind: "member.add", workspace_id: WS, user_id: USER2, role: "member" }),
      allow({ kind: "member.update_role", workspace_id: WS, user_id: USER2, role: "admin" }),
      allow({
        kind: "collection.create",
        collection_id: COLL,
        workspace_id: WS,
        parent_id: null,
        title: "Docs",
        slug: "docs",
        order_key: "a",
      }),
      allow({
        kind: "doc.create",
        doc_id: DOC,
        workspace_id: WS,
        collection_id: COLL,
        title: "Hello",
        slug: "hello",
        order_key: "a",
        visibility: "workspace",
        seed_blocks: [],
      }),
      allow({ kind: "doc.publish", doc_id: DOC, published_at: 123 }),
      allow({ kind: "doc.rename", doc_id: DOC, title: "Hello World" }),
    ]);

    expect(state.workspaces[WS]).toEqual({
      id: WS,
      slug: "acme",
      name: "Acme",
      created_by: USER,
      deleted: false,
    });
    expect(state.members[memberKey(WS, USER)]).toEqual({
      workspace_id: WS,
      user_id: USER,
      role: "owner",
      deleted: false,
    });
    expect(state.members[memberKey(WS, USER2)]).toEqual({
      workspace_id: WS,
      user_id: USER2,
      role: "admin",
      deleted: false,
    });
    expect(state.collections[COLL]).toEqual({
      id: COLL,
      workspace_id: WS,
      parent_id: null,
      title: "Docs",
      slug: "docs",
      order_key: "a",
      created_by: USER,
      deleted: false,
    });
    expect(state.docs[DOC]).toEqual({
      id: DOC,
      workspace_id: WS,
      collection_id: COLL,
      title: "Hello World",
      slug: "hello",
      order_key: "a",
      visibility: "public",
      created_by: USER,
      deleted: false,
    });
  });

  it("workspace.update patches name; non-name patch + soft_delete/restore", () => {
    let s = replay([
      allow({ kind: "workspace.create", workspace_id: WS, slug: "a", name: "A", created_by: USER }),
    ]);
    s = applyAuditRow(
      s,
      allow({ kind: "workspace.update", workspace_id: WS, patch: { name: "B" } }),
    );
    expect(s.workspaces[WS]?.name).toBe("B");
    // Non-name patch (excluded-by-contract field only) is a no-op for v1.
    s = applyAuditRow(
      s,
      allow({ kind: "workspace.update", workspace_id: WS, patch: { trash_retention_days: 7 } }),
    );
    expect(s.workspaces[WS]?.name).toBe("B");
    s = applyAuditRow(s, allow({ kind: "workspace.soft_delete", workspace_id: WS }));
    expect(s.workspaces[WS]?.deleted).toBe(true);
    s = applyAuditRow(s, allow({ kind: "workspace.restore", workspace_id: WS }));
    expect(s.workspaces[WS]?.deleted).toBe(false);
  });

  it("member.remove flips deleted", () => {
    let s = replay([
      allow({ kind: "member.add", workspace_id: WS, user_id: USER2, role: "member" }),
    ]);
    s = applyAuditRow(s, allow({ kind: "member.remove", workspace_id: WS, user_id: USER2 }));
    expect(s.members[memberKey(WS, USER2)]?.deleted).toBe(true);
  });

  it("collection lifecycle: update (partial), move, soft_delete, restore", () => {
    let s = replay([
      allow({
        kind: "collection.create",
        collection_id: COLL,
        workspace_id: WS,
        parent_id: null,
        title: "C",
        slug: "c",
        order_key: "a",
      }),
    ]);
    s = applyAuditRow(
      s,
      allow({ kind: "collection.update", collection_id: COLL, patch: { title: "C2", slug: "c2" } }),
    );
    expect(s.collections[COLL]).toMatchObject({ title: "C2", slug: "c2", order_key: "a" });
    s = applyAuditRow(
      s,
      allow({ kind: "collection.update", collection_id: COLL, patch: { order_key: "b" } }),
    );
    expect(s.collections[COLL]?.order_key).toBe("b");
    s = applyAuditRow(
      s,
      allow({
        kind: "collection.move",
        collection_id: COLL,
        new_parent_id: COLL2,
        new_order_key: "z",
      }),
    );
    expect(s.collections[COLL]).toMatchObject({ parent_id: COLL2, order_key: "z" });
    s = applyAuditRow(s, allow({ kind: "collection.soft_delete", collection_id: COLL }));
    expect(s.collections[COLL]?.deleted).toBe(true);
    s = applyAuditRow(s, allow({ kind: "collection.restore", collection_id: COLL }));
    expect(s.collections[COLL]?.deleted).toBe(false);
  });

  it("doc lifecycle: create (root), move, unpublish, soft_delete, restore", () => {
    let s = replay([
      allow({
        kind: "doc.create",
        doc_id: DOC,
        workspace_id: WS,
        collection_id: null,
        title: "D",
        slug: "d",
        order_key: "a",
        visibility: "workspace",
        seed_blocks: [],
      }),
    ]);
    expect(s.docs[DOC]).toEqual({
      id: DOC,
      workspace_id: WS,
      collection_id: null,
      title: "D",
      slug: "d",
      order_key: "a",
      visibility: "workspace",
      created_by: USER,
      deleted: false,
    });
    s = applyAuditRow(
      s,
      allow({ kind: "doc.move", doc_id: DOC, new_collection_id: COLL, new_order_key: "m" }),
    );
    expect(s.docs[DOC]).toMatchObject({ collection_id: COLL, order_key: "m" });
    s = applyAuditRow(s, allow({ kind: "doc.publish", doc_id: DOC, published_at: 5 }));
    expect(s.docs[DOC]?.visibility).toBe("public");
    s = applyAuditRow(s, allow({ kind: "doc.unpublish", doc_id: DOC }));
    expect(s.docs[DOC]?.visibility).toBe("workspace");
    s = applyAuditRow(s, allow({ kind: "doc.soft_delete", doc_id: DOC }));
    expect(s.docs[DOC]?.deleted).toBe(true);
    s = applyAuditRow(s, allow({ kind: "doc.restore", doc_id: DOC }));
    expect(s.docs[DOC]?.deleted).toBe(false);
  });
});

describe("replay reducer — no-ops", () => {
  it("deny and error rows do not mutate state", () => {
    const deny: ReplayRow = {
      principal_kind: "user",
      principal_id: USER,
      record: {
        outcome: "deny",
        reason: { kind: "cross_workspace" },
        effect: {
          kind: "deny",
          capability: CapabilityId("doc.create"),
          required_scopes: ["doc:write"],
          reason_code: "cross_workspace",
        },
      },
    };
    const error: ReplayRow = {
      principal_kind: "user",
      principal_id: USER,
      record: {
        outcome: "error",
        error: { kind: "conflict" },
        effect: {
          kind: "error",
          capability: CapabilityId("doc.create"),
          error_code: "conflict",
          retriable: false,
        },
      },
    };
    expect(applyAuditRow(EMPTY_STATE, deny)).toBe(EMPTY_STATE);
    expect(applyAuditRow(EMPTY_STATE, error)).toBe(EMPTY_STATE);
  });

  it("content, audit-only, and deferred effect classes do not mutate the metadata spine", () => {
    expect(
      applyAuditRow(
        EMPTY_STATE,
        allow({ kind: "doc.reconcile_base_token", doc_id: DOC, token: "t", expires_at: 1 }),
      ),
    ).toBe(EMPTY_STATE); // content
    expect(applyAuditRow(EMPTY_STATE, allow({ kind: "audit.access_log" }))).toBe(EMPTY_STATE); // audit-only
    expect(applyAuditRow(EMPTY_STATE, allow({ kind: "custom_domain.add", domain: "x.com" }))).toBe(
      EMPTY_STATE,
    ); // deferred
  });

  it("patches to absent entities are no-ops (truncated/partial-log safety)", () => {
    expect(
      applyAuditRow(
        EMPTY_STATE,
        allow({ kind: "workspace.update", workspace_id: WS, patch: { name: "x" } }),
      ),
    ).toBe(EMPTY_STATE);
    expect(
      applyAuditRow(
        EMPTY_STATE,
        allow({ kind: "member.update_role", workspace_id: WS, user_id: USER, role: "admin" }),
      ),
    ).toBe(EMPTY_STATE);
    expect(
      applyAuditRow(
        EMPTY_STATE,
        allow({ kind: "collection.update", collection_id: COLL, patch: { title: "x" } }),
      ),
    ).toBe(EMPTY_STATE);
    expect(applyAuditRow(EMPTY_STATE, allow({ kind: "doc.rename", doc_id: DOC, title: "x" }))).toBe(
      EMPTY_STATE,
    );
  });

  it("replay of an empty log is EMPTY_STATE", () => {
    expect(replay([])).toBe(EMPTY_STATE);
  });
});

describe("REPLAY_CLASS", () => {
  it("partitions every AuditEffect kind into the four classes", () => {
    const classes = new Set(Object.values(REPLAY_CLASS));
    expect(classes).toEqual(new Set(["state", "content", "audit-only", "deferred"]));
  });

  it("pins the load-bearing classifications", () => {
    expect(REPLAY_CLASS["doc.create"]).toBe("state");
    expect(REPLAY_CLASS["block.insert"]).toBe("content");
    expect(REPLAY_CLASS["audit.access_log"]).toBe("audit-only");
    expect(REPLAY_CLASS["admin.diagnose"]).toBe("audit-only");
    expect(REPLAY_CLASS["comment.create"]).toBe("deferred");
    expect(REPLAY_CLASS["workspace.purge"]).toBe("deferred");
  });
});
