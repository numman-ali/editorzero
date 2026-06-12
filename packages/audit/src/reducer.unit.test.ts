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

import {
  CapabilityId,
  CollectionId,
  DocId,
  GrantId,
  SpaceId,
  UserId,
  WorkspaceId,
} from "@editorzero/ids";
import { describe, expect, it } from "vitest";
import type { AuditEffect } from "./effect";
import { applyAuditRow, REPLAY_CLASS, replay } from "./reducer";
import { EMPTY_STATE, memberKey, type ReplayRow, spaceMemberKey } from "./state";

const WS = WorkspaceId("018f0000-0000-7000-8000-000000000001");
const USER = UserId("018f0000-0000-7000-8000-000000000002");
const USER2 = UserId("018f0000-0000-7000-8000-000000000003");
const COLL = CollectionId("018f0000-0000-7000-8000-0000000000c1");
const COLL2 = CollectionId("018f0000-0000-7000-8000-0000000000c2");
const DOC = DocId("018f0000-0000-7000-8000-0000000000d1");
const SPACE = SpaceId("018f0000-0000-7000-8000-0000000000e1");
const GRANT = GrantId("018f0000-0000-7000-8000-0000000000f1");
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
        space_id: null,
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
        access_mode: "space",
        seed_blocks: [],
      }),
      allow({ kind: "doc.publish", doc_id: DOC, published_slug: "hello", published_at: 123 }),
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
      space_id: null,
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
      access_mode: "space",
      // Publish is orthogonal: the rename moved the INTERNAL slug, the
      // published URL stays the value the publish effect carried.
      published_slug: "hello",
      published_at: 123,
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
          access_mode: "space",
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
          space_id: null,
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
        space_id: null,
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
        new_space_id: null,
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
        access_mode: "space",
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
      access_mode: "space",
      published_slug: null,
      published_at: null,
      created_by: USER,
      deleted_at: null,
    });
    s = applyAuditRow(
      s,
      allow({ kind: "doc.move", doc_id: DOC, new_collection_id: COLL, new_order_key: "m" }),
    );
    expect(s.docs[DOC]).toMatchObject({ collection_id: COLL, order_key: "m" });
    s = applyAuditRow(
      s,
      allow({ kind: "doc.publish", doc_id: DOC, published_slug: "d", published_at: 5 }),
    );
    expect(s.docs[DOC]).toMatchObject({ published_slug: "d", published_at: 5 });
    s = applyAuditRow(s, allow({ kind: "doc.unpublish", doc_id: DOC }));
    expect(s.docs[DOC]).toMatchObject({ published_slug: null, published_at: null });
    // Re-publish, then soft-delete: delete clears the publish dimension
    // too (a trashed doc leaves the public site — Step 5).
    s = applyAuditRow(
      s,
      allow({ kind: "doc.publish", doc_id: DOC, published_slug: "d", published_at: 7 }),
    );
    s = applyAuditRow(s, allow({ kind: "doc.soft_delete", doc_id: DOC, deleted_at: 999 }));
    expect(s.docs[DOC]).toMatchObject({
      deleted_at: 999,
      published_slug: null,
      published_at: null,
    });
    s = applyAuditRow(s, allow({ kind: "doc.restore", doc_id: DOC }));
    expect(s.docs[DOC]?.deleted_at).toBeNull();
    // Restore does NOT republish (no surprise-publication).
    expect(s.docs[DOC]?.published_at).toBeNull();
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
  "space.create": {
    kind: "space.create",
    space_id: SPACE,
    workspace_id: WS,
    space_kind: "team",
    space_type: "closed",
    owner_user_id: null,
    name: "Eng",
    slug: "eng",
    baseline_access: "view",
    created_by: USER,
  },
  "space.update": { kind: "space.update", space_id: SPACE, patch: { name: "Engineering" } },
  "space.archive": { kind: "space.archive", space_id: SPACE, deleted_at: 1 },
  "space.restore": { kind: "space.restore", space_id: SPACE },
  "space.member_add": {
    kind: "space.member_add",
    workspace_id: WS,
    space_id: SPACE,
    user_id: USER,
    role: "edit",
  },
  "space.member_remove": {
    kind: "space.member_remove",
    workspace_id: WS,
    space_id: SPACE,
    user_id: USER,
    role: "edit",
  },
  "space.member_update_role": {
    kind: "space.member_update_role",
    space_id: SPACE,
    user_id: USER,
    role: "owner",
  },
  "acl.grant": {
    kind: "acl.grant",
    grant_id: GRANT,
    workspace_id: WS,
    resource_kind: "doc",
    resource_id: DOC,
    subject_kind: "user",
    subject_id: USER2,
    role: "view",
    is_guest: 0,
    created_by: USER,
  },
  "acl.revoke": {
    kind: "acl.revoke",
    grant_id: GRANT,
    workspace_id: WS,
    resource_kind: "doc",
    resource_id: DOC,
    subject_kind: "user",
    subject_id: USER2,
    role: "view",
    is_guest: 0,
    created_by: USER,
  },
  "collection.create": {
    kind: "collection.create",
    collection_id: COLL,
    workspace_id: WS,
    parent_id: null,
    space_id: null,
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
    new_space_id: SPACE,
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
    access_mode: "space",
    seed_blocks: [],
  },
  "doc.rename": { kind: "doc.rename", doc_id: DOC, title: "Hello World", slug: "hello-world" },
  // Exercises the FULL shape (the optional cross-boundary transition) so
  // the canonical fixture pins it; absence is the common case and is
  // covered by the lifecycle walks above.
  "doc.move": {
    kind: "doc.move",
    doc_id: DOC,
    new_collection_id: null,
    new_order_key: "m",
    acl_transition: {
      policy: "adopt_baseline",
      before_space_id: SPACE,
      after_space_id: null,
      dropped_grant_ids: [GRANT],
    },
  },
  "doc.publish": { kind: "doc.publish", doc_id: DOC, published_slug: "d", published_at: 1 },
  "doc.unpublish": { kind: "doc.unpublish", doc_id: DOC },
  "doc.soft_delete": { kind: "doc.soft_delete", doc_id: DOC, deleted_at: 1 },
  "doc.restore": { kind: "doc.restore", doc_id: DOC },
} satisfies { [K in StateKind]: Extract<AuditEffect, { kind: K }> };

// ── Space family semantics (ADR 0040 Step 7) ───────────────────────────────
//
// The effects land BEFORE their Step-8 capabilities — born `"state"`
// with transitions (the integration walk reaches them at Step 8; these
// unit walks are the replay-sufficiency proof until then).

describe("replay reducer — space family (ADR 0040 Step 7)", () => {
  const create = allow({
    kind: "space.create",
    space_id: SPACE,
    workspace_id: WS,
    space_kind: "team",
    space_type: "closed",
    owner_user_id: null,
    name: "Eng",
    slug: "eng",
    baseline_access: "view",
    created_by: USER,
  });

  it("create → update → archive → restore reconstructs the full lifecycle", () => {
    const state = replay([
      create,
      allow({
        kind: "space.update",
        space_id: SPACE,
        patch: { name: "Engineering", space_type: "open", baseline_access: "comment" },
      }),
      allow({ kind: "space.archive", space_id: SPACE, deleted_at: 77 }),
    ]);
    expect(state.spaces[SPACE]).toEqual({
      id: SPACE,
      workspace_id: WS,
      kind: "team",
      type: "open", // space_type patch maps onto the row's `type`
      owner_user_id: null,
      name: "Engineering",
      slug: "eng",
      baseline_access: "comment",
      created_by: USER,
      deleted_at: 77, // the handler clock, verbatim (ADR 0017 anchor)
    });
    const restored = replay([
      create,
      allow({ kind: "space.archive", space_id: SPACE, deleted_at: 77 }),
      allow({ kind: "space.restore", space_id: SPACE }),
    ]);
    expect(restored.spaces[SPACE]?.deleted_at).toBeNull();
  });

  it("member add → update_role → remove nets to NO entry (hard-DELETE projection)", () => {
    const afterAdd = replay([
      create,
      allow({
        kind: "space.member_add",
        workspace_id: WS,
        space_id: SPACE,
        user_id: USER2,
        role: "view",
      }),
      allow({ kind: "space.member_update_role", space_id: SPACE, user_id: USER2, role: "edit" }),
    ]);
    expect(afterAdd.space_members[spaceMemberKey(SPACE, USER2)]).toEqual({
      workspace_id: WS,
      space_id: SPACE,
      user_id: USER2,
      role: "edit",
    });
    const afterRemove = replay([
      create,
      allow({
        kind: "space.member_add",
        workspace_id: WS,
        space_id: SPACE,
        user_id: USER2,
        role: "view",
      }),
      allow({
        kind: "space.member_remove",
        workspace_id: WS,
        space_id: SPACE,
        user_id: USER2,
        role: "view",
      }),
    ]);
    expect(afterRemove.space_members).toEqual({});
    // Re-add after remove starts a fresh row (no resurrecting state).
    const reAdded = replay([
      create,
      allow({
        kind: "space.member_add",
        workspace_id: WS,
        space_id: SPACE,
        user_id: USER2,
        role: "owner",
      }),
      allow({
        kind: "space.member_remove",
        workspace_id: WS,
        space_id: SPACE,
        user_id: USER2,
        role: "owner",
      }),
      allow({
        kind: "space.member_add",
        workspace_id: WS,
        space_id: SPACE,
        user_id: USER2,
        role: "view",
      }),
    ]);
    expect(reAdded.space_members[spaceMemberKey(SPACE, USER2)]?.role).toBe("view");
  });

  it("patches and removes against absent entities are safe no-ops (truncated-log resilience)", () => {
    expect(
      applyAuditRow(
        EMPTY_STATE,
        allow({ kind: "space.update", space_id: SPACE, patch: { name: "x" } }),
      ),
    ).toBe(EMPTY_STATE);
    expect(
      applyAuditRow(
        EMPTY_STATE,
        allow({
          kind: "space.member_remove",
          workspace_id: WS,
          space_id: SPACE,
          user_id: USER,
          role: "view",
        }),
      ),
    ).toBe(EMPTY_STATE);
    expect(
      applyAuditRow(
        EMPTY_STATE,
        allow({ kind: "space.member_update_role", space_id: SPACE, user_id: USER, role: "view" }),
      ),
    ).toBe(EMPTY_STATE);
  });
});

describe("replay reducer — grants (ADR 0040 Step 7)", () => {
  const BOT_SUBJECT = "018f0000-0000-7000-8000-0000000000b1";
  const grant = allow({
    kind: "acl.grant",
    grant_id: GRANT,
    workspace_id: WS,
    resource_kind: "space",
    resource_id: SPACE,
    subject_kind: "agent",
    subject_id: BOT_SUBJECT,
    role: "comment",
    is_guest: 1,
    created_by: USER,
  });

  it("acl.grant projects the full GrantState (guest marker included)", () => {
    const state = replay([grant]);
    expect(state.grants[GRANT]).toEqual({
      id: GRANT,
      workspace_id: WS,
      resource_kind: "space",
      resource_id: SPACE,
      subject_kind: "agent",
      subject_id: BOT_SUBJECT,
      role: "comment",
      is_guest: 1,
      created_by: USER,
    });
  });

  it("grant-then-revoke nets to NO entry (H1 hard-delete projection)", () => {
    const state = replay([
      grant,
      allow({
        kind: "acl.revoke",
        grant_id: GRANT,
        workspace_id: WS,
        resource_kind: "space",
        resource_id: SPACE,
        subject_kind: "agent",
        subject_id: BOT_SUBJECT,
        role: "comment",
        is_guest: 1,
        created_by: USER,
      }),
    ]);
    expect(state.grants).toEqual({});
  });

  it("re-grant under the same grant_id converges (the role-change posture)", () => {
    const state = replay([
      grant,
      allow({
        kind: "acl.grant",
        grant_id: GRANT,
        workspace_id: WS,
        resource_kind: "space",
        resource_id: SPACE,
        subject_kind: "agent",
        subject_id: BOT_SUBJECT,
        role: "edit",
        is_guest: 1,
        created_by: USER,
      }),
    ]);
    expect(Object.keys(state.grants)).toHaveLength(1);
    expect(state.grants[GRANT]?.role).toBe("edit");
  });

  it("revoking an absent grant is a safe no-op (truncated-log resilience)", () => {
    expect(
      applyAuditRow(
        EMPTY_STATE,
        allow({
          kind: "acl.revoke",
          grant_id: GRANT,
          workspace_id: WS,
          resource_kind: "doc",
          resource_id: DOC,
          subject_kind: "user",
          subject_id: USER2,
          role: "view",
          is_guest: 0,
          created_by: USER,
        }),
      ),
    ).toBe(EMPTY_STATE);
  });
});

// ── Placement lockstep (ADR 0040 Step 7, commit C) ─────────────────────────

describe("replay reducer — collection space binding + doc.move acl_transition", () => {
  const mkColl = (
    id: CollectionId,
    parent_id: CollectionId | null,
    space_id: SpaceId | null = null,
  ) =>
    allow({
      kind: "collection.create",
      collection_id: id,
      workspace_id: WS,
      parent_id,
      space_id,
      title: "C",
      slug: `c-${id.slice(-2)}`,
      order_key: "a",
      created_by: USER,
    });

  it("collection.create projects its space binding", () => {
    const state = replay([mkColl(COLL, null, SPACE)]);
    expect(state.collections[COLL]?.space_id).toBe(SPACE);
  });

  it("collection.move rebinds the WHOLE subtree (denormalization invariant)", () => {
    // COLL (root) ← COLL2 (child) ← COLL3 (grandchild); sibling COLL4 is
    // outside the subtree and must keep its own binding.
    const COLL3 = CollectionId("018f0000-0000-7000-8000-0000000000c3");
    const COLL4 = CollectionId("018f0000-0000-7000-8000-0000000000c4");
    const state = replay([
      mkColl(COLL, null),
      mkColl(COLL2, COLL),
      mkColl(COLL3, COLL2),
      mkColl(COLL4, null),
      allow({
        kind: "collection.move",
        collection_id: COLL,
        new_parent_id: null,
        new_order_key: "z",
        new_space_id: SPACE,
      }),
    ]);
    expect(state.collections[COLL]?.space_id).toBe(SPACE);
    expect(state.collections[COLL2]?.space_id).toBe(SPACE);
    expect(state.collections[COLL3]?.space_id).toBe(SPACE);
    expect(state.collections[COLL4]?.space_id).toBeNull();
  });

  const grantOnDoc = allow({
    kind: "acl.grant",
    grant_id: GRANT,
    workspace_id: WS,
    resource_kind: "doc",
    resource_id: DOC,
    subject_kind: "user",
    subject_id: USER2,
    role: "view",
    is_guest: 0,
    created_by: USER,
  });
  const docCreate = allow({
    kind: "doc.create",
    doc_id: DOC,
    workspace_id: WS,
    collection_id: COLL,
    title: "D",
    slug: "d",
    order_key: "a",
    created_by: USER,
    access_mode: "space",
    seed_blocks: [],
  });

  it("doc.move adopt_baseline drops exactly the listed grants", () => {
    const state = replay([
      docCreate,
      grantOnDoc,
      allow({
        kind: "doc.move",
        doc_id: DOC,
        new_collection_id: COLL2,
        new_order_key: "m",
        acl_transition: {
          policy: "adopt_baseline",
          before_space_id: SPACE,
          after_space_id: null,
          dropped_grant_ids: [GRANT],
        },
      }),
    ]);
    expect(state.docs[DOC]).toMatchObject({ collection_id: COLL2, order_key: "m" });
    expect(state.grants).toEqual({});
  });

  it("doc.move keep_grants (empty dropped list) leaves grants intact", () => {
    const state = replay([
      docCreate,
      grantOnDoc,
      allow({
        kind: "doc.move",
        doc_id: DOC,
        new_collection_id: COLL2,
        new_order_key: "m",
        acl_transition: {
          policy: "keep_grants",
          before_space_id: SPACE,
          after_space_id: null,
          dropped_grant_ids: [],
        },
      }),
    ]);
    expect(state.grants[GRANT]?.id).toBe(GRANT);
  });

  it("doc.move without acl_transition (same-bucket — every shipped move) touches no grants", () => {
    const state = replay([
      docCreate,
      grantOnDoc,
      allow({ kind: "doc.move", doc_id: DOC, new_collection_id: COLL2, new_order_key: "m" }),
    ]);
    expect(state.grants[GRANT]?.id).toBe(GRANT);
  });
});

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
