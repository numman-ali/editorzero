/**
 * Reducer unit tests — pure typed fixtures (no DB, no dispatcher).
 *
 * These prove the effect→state contract in isolation:
 *   - every `"state"`-classed kind has a real transition (the per-kind
 *     gate — a kind classified `"state"` without a transition would hit
 *     `applyStateEffect`'s `default` throw and fail here);
 *   - `created_by` reconstructs from the effect body, NOT the envelope
 *     principal — correct for an agent write, where the principal is the
 *     agent but the attribution is the human behind it (Codex review HIGH 1);
 *   - `deleted_at` reconstructs the exact handler timestamp the soft_delete
 *     effect carries (ADR 0017 recovery anchor — Codex review HIGH 4);
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
// A non-user principal id, used to prove `created_by` comes from the effect
// body, not the envelope `principal_id` (agent writes attribute to a human).
const AGENT_PRINCIPAL = "018f0000-0000-7000-8000-0000000000f1";

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
        trash_retention_days: 30,
        settings: {},
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
        created_by: USER,
      }),
      allow({
        kind: "doc.create",
        doc_id: DOC,
        workspace_id: WS,
        collection_id: COLL,
        title: "Hello",
        slug: "hello",
        order_key: "a",
        created_by: USER,
        visibility: "workspace",
        seed_blocks: [],
      }),
      allow({ kind: "doc.publish", doc_id: DOC, published_at: 123 }),
      allow({ kind: "doc.rename", doc_id: DOC, title: "Hello World", slug: "hello-world" }),
    ]);

    expect(state.workspaces[WS]).toEqual({
      id: WS,
      slug: "acme",
      name: "Acme",
      trash_retention_days: 30,
      settings: {},
      created_by: USER,
      deleted_at: null,
    });
    expect(state.members[memberKey(WS, USER)]).toEqual({
      workspace_id: WS,
      user_id: USER,
      role: "owner",
      deleted_at: null,
    });
    expect(state.members[memberKey(WS, USER2)]).toEqual({
      workspace_id: WS,
      user_id: USER2,
      role: "admin",
      deleted_at: null,
    });
    expect(state.collections[COLL]).toEqual({
      id: COLL,
      workspace_id: WS,
      parent_id: null,
      title: "Docs",
      slug: "docs",
      order_key: "a",
      created_by: USER,
      deleted_at: null,
    });
    expect(state.docs[DOC]).toEqual({
      id: DOC,
      workspace_id: WS,
      collection_id: COLL,
      title: "Hello World",
      // Follows the rename: the effect carries the handler-slugified value, so
      // replay moves the slug off the create-time "hello" (the drop this
      // assertion previously masked).
      slug: "hello-world",
      order_key: "a",
      visibility: "public",
      created_by: USER,
      deleted_at: null,
    });
  });

  it("reconstructs created_by from the effect, not the envelope principal (agent write)", () => {
    // An agent write: the audit envelope's `principal_id` is the AGENT, but
    // the handler attributes the doc/collection to the human behind it
    // (`acting_as` / `owner_user_id`). The effect carries that human id;
    // replay must read the effect, never the envelope — else an
    // agent-created entity reconstructs with the wrong owner (Codex review
    // HIGH 1). Reconstructing from `principal_id` (the old behaviour) would
    // put the agent's id in `created_by`, breaking the brand and the
    // attribution.
    const docRow: ReplayRow = {
      principal_kind: "agent",
      principal_id: AGENT_PRINCIPAL,
      record: {
        outcome: "allow",
        effect: {
          kind: "doc.create",
          doc_id: DOC,
          workspace_id: WS,
          collection_id: null,
          title: "Agent doc",
          slug: "agent-doc",
          order_key: "a",
          created_by: USER, // the human behind the agent
          visibility: "workspace",
          seed_blocks: [],
        },
      },
    };
    const collRow: ReplayRow = {
      principal_kind: "agent",
      principal_id: AGENT_PRINCIPAL,
      record: {
        outcome: "allow",
        effect: {
          kind: "collection.create",
          collection_id: COLL,
          workspace_id: WS,
          parent_id: null,
          title: "Agent coll",
          slug: "agent-coll",
          order_key: "a",
          created_by: USER,
        },
      },
    };
    const state = replay([docRow, collRow]);
    expect(state.docs[DOC]?.created_by).toBe(USER);
    expect(state.collections[COLL]?.created_by).toBe(USER);
    // Definitely NOT the agent principal id (the envelope is ignored).
    expect(state.docs[DOC]?.created_by).not.toBe(AGENT_PRINCIPAL);
    expect(state.collections[COLL]?.created_by).not.toBe(AGENT_PRINCIPAL);
  });

  it("workspace.update applies name + retention + settings; soft_delete/restore set deleted_at", () => {
    let s = replay([
      allow({
        kind: "workspace.create",
        workspace_id: WS,
        slug: "a",
        name: "A",
        trash_retention_days: 30,
        settings: {},
        created_by: USER,
      }),
    ]);
    // name patch
    s = applyAuditRow(
      s,
      allow({ kind: "workspace.update", workspace_id: WS, patch: { name: "B" } }),
    );
    expect(s.workspaces[WS]?.name).toBe("B");
    expect(s.workspaces[WS]?.trash_retention_days).toBe(30);
    // retention patch (was an excluded-by-contract no-op before HIGH 3)
    s = applyAuditRow(
      s,
      allow({ kind: "workspace.update", workspace_id: WS, patch: { trash_retention_days: 7 } }),
    );
    expect(s.workspaces[WS]?.trash_retention_days).toBe(7);
    expect(s.workspaces[WS]?.name).toBe("B"); // unspecified field untouched
    // settings patch — carried as the parsed object
    s = applyAuditRow(
      s,
      allow({ kind: "workspace.update", workspace_id: WS, patch: { settings: { theme: "dark" } } }),
    );
    expect(s.workspaces[WS]?.settings).toEqual({ theme: "dark" });
    // soft_delete carries the handler timestamp; restore clears it
    s = applyAuditRow(
      s,
      allow({ kind: "workspace.soft_delete", workspace_id: WS, deleted_at: 555 }),
    );
    expect(s.workspaces[WS]?.deleted_at).toBe(555);
    s = applyAuditRow(s, allow({ kind: "workspace.restore", workspace_id: WS }));
    expect(s.workspaces[WS]?.deleted_at).toBeNull();
  });

  it("member.remove sets deleted_at to the carried timestamp", () => {
    let s = replay([
      allow({ kind: "member.add", workspace_id: WS, user_id: USER2, role: "member" }),
    ]);
    expect(s.members[memberKey(WS, USER2)]?.deleted_at).toBeNull();
    s = applyAuditRow(
      s,
      allow({ kind: "member.remove", workspace_id: WS, user_id: USER2, deleted_at: 777 }),
    );
    expect(s.members[memberKey(WS, USER2)]?.deleted_at).toBe(777);
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
        created_by: USER,
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
    s = applyAuditRow(
      s,
      allow({ kind: "collection.soft_delete", collection_id: COLL, deleted_at: 888 }),
    );
    expect(s.collections[COLL]?.deleted_at).toBe(888);
    s = applyAuditRow(s, allow({ kind: "collection.restore", collection_id: COLL }));
    expect(s.collections[COLL]?.deleted_at).toBeNull();
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
        created_by: USER,
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
      deleted_at: null,
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
    s = applyAuditRow(s, allow({ kind: "doc.soft_delete", doc_id: DOC, deleted_at: 999 }));
    expect(s.docs[DOC]?.deleted_at).toBe(999);
    s = applyAuditRow(s, allow({ kind: "doc.restore", doc_id: DOC }));
    expect(s.docs[DOC]?.deleted_at).toBeNull();
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
    expect(
      applyAuditRow(EMPTY_STATE, allow({ kind: "doc.rename", doc_id: DOC, title: "x", slug: "x" })),
    ).toBe(EMPTY_STATE);
  });

  it("replay of an empty log is EMPTY_STATE", () => {
    expect(replay([])).toBe(EMPTY_STATE);
  });
});

// ── Per-kind transition coverage (the runtime half of reducer.ts §forcing) ──
//
// `StateKind` is exactly the set of kinds `REPLAY_CLASS` classifies `"state"`.
// `STATE_KIND_FIXTURES` `satisfies` a total record over it, so a newly-added
// `"state"` kind that lacks a fixture fails to COMPILE here. `it.each` then
// drives every fixture through `applyAuditRow` → `applyStateEffect`; a fixtured
// `"state"` kind with no transition hits the `default` throw — a red test. The
// two locks together back the contract docstring in `reducer.ts`.
type StateKind = {
  [K in keyof typeof REPLAY_CLASS]: (typeof REPLAY_CLASS)[K] extends "state" ? K : never;
}[keyof typeof REPLAY_CLASS];

const STATE_KIND_FIXTURES = {
  "workspace.create": {
    kind: "workspace.create",
    workspace_id: WS,
    slug: "acme",
    name: "Acme",
    trash_retention_days: 30,
    settings: {},
    created_by: USER,
  },
  "workspace.update": { kind: "workspace.update", workspace_id: WS, patch: { name: "B" } },
  "workspace.soft_delete": { kind: "workspace.soft_delete", workspace_id: WS, deleted_at: 1 },
  "workspace.restore": { kind: "workspace.restore", workspace_id: WS },
  "member.add": { kind: "member.add", workspace_id: WS, user_id: USER, role: "owner" },
  "member.remove": { kind: "member.remove", workspace_id: WS, user_id: USER, deleted_at: 1 },
  "member.update_role": {
    kind: "member.update_role",
    workspace_id: WS,
    user_id: USER,
    role: "admin",
  },
  "collection.create": {
    kind: "collection.create",
    collection_id: COLL,
    workspace_id: WS,
    parent_id: null,
    title: "Docs",
    slug: "docs",
    order_key: "a",
    created_by: USER,
  },
  "collection.update": { kind: "collection.update", collection_id: COLL, patch: { title: "x" } },
  "collection.move": {
    kind: "collection.move",
    collection_id: COLL,
    new_parent_id: null,
    new_order_key: "z",
  },
  "collection.soft_delete": { kind: "collection.soft_delete", collection_id: COLL, deleted_at: 1 },
  "collection.restore": { kind: "collection.restore", collection_id: COLL },
  "doc.create": {
    kind: "doc.create",
    doc_id: DOC,
    workspace_id: WS,
    collection_id: null,
    title: "Hello",
    slug: "hello",
    order_key: "a",
    created_by: USER,
    visibility: "workspace",
    seed_blocks: [],
  },
  "doc.rename": { kind: "doc.rename", doc_id: DOC, title: "Hello World", slug: "hello-world" },
  "doc.move": { kind: "doc.move", doc_id: DOC, new_collection_id: null, new_order_key: "m" },
  "doc.publish": { kind: "doc.publish", doc_id: DOC, published_at: 1 },
  "doc.unpublish": { kind: "doc.unpublish", doc_id: DOC },
  "doc.soft_delete": { kind: "doc.soft_delete", doc_id: DOC, deleted_at: 1 },
  "doc.restore": { kind: "doc.restore", doc_id: DOC },
} satisfies { [K in StateKind]: Extract<AuditEffect, { kind: K }> };

describe('replay reducer — every "state" kind has a transition', () => {
  it.each(
    Object.entries(STATE_KIND_FIXTURES),
  )("%s is a real transition, not the unclassified-state throw", (_kind, effect) => {
    expect(() => applyAuditRow(EMPTY_STATE, allow(effect))).not.toThrow();
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
