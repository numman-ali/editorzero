/**
 * The revocation tap (ADR 0043 Decision 5, review MUST-FIX 3) —
 * event-driven closes after revoke-class capability commits.
 *
 * `getApiApp` wraps the dispatcher so every SUCCESSFUL dispatch flows
 * through `afterCommit` (the SQL tx has committed and the resident
 * applied by the time `dispatch` resolves). For the revoke-class set
 * the tap derives the affected user(s) and closes their collab
 * sockets via the registry; `doc.delete` instead closes the trashed
 * doc's ROOM (per-document connections, via the sync layer);
 * everything else is a Map miss. The Better Auth sign-out arm is
 * separate (`onAuthRevoked` on `createApiApp`).
 *
 * **The reader ladder (Codex lift-gate round, MUST-FIX 1).** "Who can
 * read a bucket's docs via placement" is NOT just the space roster:
 * the workspace-root bucket and OPEN spaces read for every live
 * workspace member (org baseline), personal spaces read for their
 * owner, and user-kind SPACE grants confer read without a roster row.
 * `bucketReaders` walks that ladder; everywhere the tap needs
 * "placement readers of bucket X" it uses the ladder, never the
 * roster alone. Over-close of readers who retain standing some other
 * way is accepted bluntness — re-attach re-runs `collabAuthorize`,
 * the authority. Under-close is the leak.
 *
 * Affected-subject derivation per capability:
 *
 *   - `permission.revoke` / `doc.remove_guest` — the deleted edge is
 *     echoed verbatim in the output (`GrantRowOutputSchema`); the
 *     subject closes whether `user` (→ `closeByUser`) or `agent` (→
 *     `closeByAgent`). ADR 0044 Decision 5 dropped the old agent-kind
 *     skip — agent sockets exist now on the bearer lane, so a revoked
 *     agent grant closes the agent's feeds, same posture as a user grant.
 *   - `agent.revoke` / `agent.token_revoke` (ADR 0044 Decision 5) — the
 *     terminal echo carries `agent_id` / `token_id`; the whole agent's
 *     feeds close (`closeByAgent`) or just the one token's (`closeByToken`).
 *   - `space.member_remove` / `space.member_update_role` /
 *     `workspace.member_remove` / `workspace.member_update_role` —
 *     the output echoes the affected `user_id`. Role UPDATES close
 *     too: a narrowed role must drop live read feeds the old role
 *     justified. `workspace.member_remove` ALSO closes the removed
 *     owner's live agents (ADR 0044 Decision 2: owner-liveness gates the
 *     token resolve, so removing the owner strands the agent's feeds).
 *   - `doc.delete` — closes the doc's ROOM, not user sockets: every
 *     per-document connection on the trashed doc gets the revocation
 *     Close frame (`closeDocConnections` → the sync layer). Exactly
 *     scoped — a baseline reader's passive subscription dies with the
 *     room (re-attach is denied on the soft-deleted row), while their
 *     SOCKET survives for other docs, and no grant standing changed
 *     (grant rows persist through soft-delete; restore revives them).
 *     Closing every member's socket here would storm the workspace on
 *     a routine verb.
 *   - `space.archive` — `bucketReaders` of the archived space.
 *     HARDENING-ONLY in the normal path: compliant `space.archive`
 *     refuses while live descendants exist, so there are no attached
 *     doc readers to strand — this entry matters only for
 *     corrupt-state shapes (docs stranded under trashed collections
 *     going to anomaly), where the full ladder is the right set.
 *   - `doc.move` / `collection.move` — a bucket CROSSING narrows read
 *     standing two ways, both derivable from the `acl_transition`
 *     echo (absent on same-bucket moves — those change no reader):
 *     `dropped_grants` preimages are revoked edges (the echo's own
 *     docstring calls it "the `permission.revoke` posture") — their
 *     user-kind subjects close; and the BEFORE bucket's readers (the
 *     full ladder) close when the AFTER bucket is restrictive
 *     (closed/private — root and open spaces keep every member
 *     readable, so landing there strands nobody).
 *   - `space.update` — keyed off the INPUT, not the output:
 *     `space_type` is only present when the caller is SETTING it (a
 *     rename never carries it — no rename-storm bluntness), and a
 *     refusal (personal spaces refuse type changes) never reaches the
 *     tap. Setting `open` widens — skip; setting closed/private
 *     removes the org baseline, so every live workspace member
 *     except the space's roster closes. Re-setting an
 *     already-restrictive type over-closes the same set — rare (the
 *     SPA's `diffSpacePatch` sends only changed fields) and
 *     self-healing.
 *
 * Outputs are narrowed through the SSOT zod schemas
 * (`@editorzero/schemas`) — never cast. A parse miss means the
 * capability's shape drifted from this tap: that logs loud as an
 * error (drift guard) and closes nothing.
 *
 * **The tap never throws into the dispatch path.** The mutation is
 * durable by the time it runs; a tap failure is a liveness gap
 * (sockets linger until their next refused write), not a correctness
 * hole — log loud, return the output.
 */

import type { SqliteDriver } from "@editorzero/db";
import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { AgentId, SpaceId, TokenId, UserId, type WorkspaceId } from "@editorzero/ids";
import type { Logger } from "@editorzero/observability";
import { AclTransitionOutputSchema, GrantRowOutputSchema } from "@editorzero/schemas/shared/grant";
import { SpaceTypeSchema } from "@editorzero/schemas/shared/space";
import { z } from "zod";

import type { CollabSocketRegistry } from "./collabSockets";

/** Output slice shared by the four membership ops — `user_id` is all the tap reads. */
const MemberOutputSchema = z.object({ user_id: z.string() }).loose();
const DocDeleteOutputSchema = z.object({ doc_id: z.string() }).loose();
const SpaceArchiveOutputSchema = z.object({ space_id: z.string() }).loose();
/** Output slice shared by both movers — the crossing receipt is all the tap reads. */
const MoveOutputSchema = z.object({ acl_transition: AclTransitionOutputSchema.optional() }).loose();
/** Input slice for `space.update` — the tap keys off the caller SETTING a type. */
const SpaceUpdateInputSchema = z
  .object({ space_id: z.string(), space_type: SpaceTypeSchema.optional() })
  .loose();
/** Terminal echo of `agent.revoke` — `agent_id` is all the tap reads. */
const AgentRevokeOutputSchema = z.object({ agent_id: z.string() }).loose();
/** Terminal echo of `agent.token_revoke` — `token_id` is all the tap reads. */
const TokenRevokeOutputSchema = z.object({ token_id: z.string() }).loose();

export interface RevocationTapDeps {
  readonly registry: CollabSocketRegistry;
  readonly driver: SqliteDriver;
  readonly logger: Logger;
  /**
   * Per-document room close (`HocuspocusSync.closeDocumentConnections`
   * in the composition root). The `doc.delete` arm requires it — an
   * unwired arm on a doc.delete commit is a contained, loudly-logged
   * tap failure, never a crash.
   */
  readonly closeDocConnections?: (doc_id: string) => number;
}

export interface RevocationTap {
  /** Fire-and-contain: derives affected readers, closes their feeds. */
  afterCommit(invocation: DispatchInvocation, output: unknown): Promise<void>;
}

/**
 * A subject whose collab feeds a revoke-class commit closes. The kind
 * picks the registry close method (ADR 0044 Decision 5): `user` →
 * `closeByUser`, `agent` → `closeByAgent` (the owning agent revoked, or
 * its owner removed from the workspace), `token` → `closeByToken` (a
 * single agent token revoked).
 */
type CloseTarget =
  | { readonly kind: "user"; readonly user_id: UserId }
  | { readonly kind: "agent"; readonly agent_id: AgentId }
  | { readonly kind: "token"; readonly token_id: TokenId };

export function createRevocationTap(deps: RevocationTapDeps): RevocationTap {
  const { registry, driver, logger, closeDocConnections } = deps;

  type Extractor = (invocation: DispatchInvocation, output: unknown) => Promise<CloseTarget[]>;

  async function liveWorkspaceMembers(workspace: WorkspaceId): Promise<UserId[]> {
    const rows = await driver
      .scoped(workspace)
      .selectFrom("workspace_members")
      .select("user_id")
      .where("deleted_at", "is", null)
      .execute();
    return rows.map((row) => row.user_id);
  }

  /**
   * Placement-derived readers of a bucket (the MUST-FIX 1 ladder; see
   * the file header). `null` = the workspace-root bucket. A missing
   * space row reads as the widest set — fail toward closing.
   */
  async function bucketReaders(
    workspace: WorkspaceId,
    space_id: SpaceId | null,
  ): Promise<UserId[]> {
    if (space_id === null) return liveWorkspaceMembers(workspace);
    const space = await driver
      .scoped(workspace)
      .selectFrom("spaces")
      .select(["type", "owner_user_id"])
      .where("id", "=", space_id)
      .executeTakeFirst();
    if (space === undefined || space.type === "open") {
      return liveWorkspaceMembers(workspace);
    }
    const readers = new Set<UserId>();
    if (space.owner_user_id !== null) readers.add(space.owner_user_id);
    const roster = await driver
      .scoped(workspace)
      .selectFrom("space_members")
      .select("user_id")
      .where("space_id", "=", space_id)
      .execute();
    for (const row of roster) readers.add(row.user_id);
    const spaceGrants = await driver
      .scoped(workspace)
      .selectFrom("grants")
      .select("subject_id")
      .where("resource_kind", "=", "space")
      .where("resource_id", "=", space_id)
      .where("subject_kind", "=", "user")
      .execute();
    for (const row of spaceGrants) readers.add(UserId(row.subject_id));
    return [...readers];
  }

  const grantEdgeSubject: Extractor = (_invocation, output) => {
    const parsed = GrantRowOutputSchema.safeParse(output);
    if (!parsed.success) return Promise.reject(new Error("output is not a grant row"));
    const { subject_kind, subject_id } = parsed.data;
    // ADR 0044 Decision 5: the agent-kind skip is GONE — a revoked agent
    // grant closes the agent's feeds, same posture as a user grant (agent
    // sockets can now exist on the bearer lane).
    if (subject_kind === "agent") {
      return Promise.resolve([{ kind: "agent", agent_id: AgentId(subject_id) }]);
    }
    return Promise.resolve([{ kind: "user", user_id: UserId(subject_id) }]);
  };

  const memberSubject: Extractor = (_invocation, output) => {
    const parsed = MemberOutputSchema.safeParse(output);
    if (!parsed.success) return Promise.reject(new Error("output carries no user_id"));
    return Promise.resolve([{ kind: "user", user_id: UserId(parsed.data.user_id) }]);
  };

  /**
   * `workspace.member_remove` — the removed user AND every live agent they
   * own (ADR 0044 Decision 2: resolution joins the owner's live membership,
   * so removing the owner kills their agents' tokens). Per-frame
   * re-resolution would catch the next write; this closes the passive read
   * feeds too. Revoked agents already hold no sockets, so the
   * `revoked_at IS NULL` filter is the live set.
   */
  const workspaceMemberRemoveSubjects: Extractor = async (invocation, output) => {
    const parsed = MemberOutputSchema.safeParse(output);
    if (!parsed.success) throw new Error("output carries no user_id");
    const owner = UserId(parsed.data.user_id);
    const targets: CloseTarget[] = [{ kind: "user", user_id: owner }];
    const ownedAgents = await driver
      .scoped(invocation.principal.workspace_id)
      .selectFrom("agents")
      .select("id")
      .where("owner_user_id", "=", owner)
      .where("revoked_at", "is", null)
      .execute();
    for (const row of ownedAgents) {
      targets.push({ kind: "agent", agent_id: AgentId(row.id) });
    }
    return targets;
  };

  const agentRevokeSubject: Extractor = (_invocation, output) => {
    const parsed = AgentRevokeOutputSchema.safeParse(output);
    if (!parsed.success) return Promise.reject(new Error("output carries no agent_id"));
    return Promise.resolve([{ kind: "agent", agent_id: AgentId(parsed.data.agent_id) }]);
  };

  const tokenRevokeSubject: Extractor = (_invocation, output) => {
    const parsed = TokenRevokeOutputSchema.safeParse(output);
    if (!parsed.success) return Promise.reject(new Error("output carries no token_id"));
    return Promise.resolve([{ kind: "token", token_id: TokenId(parsed.data.token_id) }]);
  };

  const spaceArchiveSubjects: Extractor = async (invocation, output) => {
    const parsed = SpaceArchiveOutputSchema.safeParse(output);
    if (!parsed.success) throw new Error("output carries no space_id");
    const readers = await bucketReaders(
      invocation.principal.workspace_id,
      SpaceId(parsed.data.space_id),
    );
    return readers.map((user_id) => ({ kind: "user", user_id }));
  };

  const moveCrossingSubjects: Extractor = async (invocation, output) => {
    const parsed = MoveOutputSchema.safeParse(output);
    if (!parsed.success) throw new Error("output carries no recognizable move echo");
    const transition = parsed.data.acl_transition;
    // Same-bucket move: no crossing receipt, no reader change.
    if (transition === undefined) return [];
    const workspace = invocation.principal.workspace_id;
    const users = new Set<UserId>();
    const agents = new Set<AgentId>();
    // Dropped grant edges are revocations regardless of placement
    // direction (`adopt_baseline` hard-deletes them; the echo carries
    // the preimages) — user AND agent subjects close, the same
    // permission.revoke posture (ADR 0044 Decision 5; agent skip dropped).
    for (const grant of transition.dropped_grants) {
      if (grant.subject_kind === "agent") agents.add(AgentId(grant.subject_id));
      else users.add(UserId(grant.subject_id));
    }
    // The BEFORE bucket's readers close only when the AFTER bucket
    // excludes them: the root bucket and open spaces keep every
    // workspace member readable; closed/private do not. A missing
    // after-space row reads as restrictive — fail toward closing
    // (re-attach is cheap; a leak is not).
    const afterRestrictive =
      transition.after_space_id !== null &&
      (
        await driver
          .scoped(workspace)
          .selectFrom("spaces")
          .select("type")
          .where("id", "=", transition.after_space_id)
          .executeTakeFirst()
      )?.type !== "open";
    if (afterRestrictive) {
      // Placement readers are users only — an agent reads a bucket via a
      // GRANT (caught above when the move drops it), never via the
      // org-baseline / space-roster paths `bucketReaders` walks.
      for (const reader of await bucketReaders(workspace, transition.before_space_id)) {
        users.add(reader);
      }
    }
    const targets: CloseTarget[] = [];
    for (const user_id of users) targets.push({ kind: "user", user_id });
    for (const agent_id of agents) targets.push({ kind: "agent", agent_id });
    return targets;
  };

  const spaceTypeNarrowingSubjects: Extractor = async (invocation, _output) => {
    const parsed = SpaceUpdateInputSchema.safeParse(invocation.input);
    if (!parsed.success) throw new Error("input carries no recognizable space.update shape");
    const { space_id, space_type } = parsed.data;
    // No `space_type` in the input = a rename/baseline patch — the
    // type did not change, no reader narrows. Setting `open` widens.
    if (space_type === undefined || space_type === "open") return [];
    const workspace = invocation.principal.workspace_id;
    const spaceId = SpaceId(space_id);
    const retained = new Set(
      (
        await driver
          .scoped(workspace)
          .selectFrom("space_members")
          .select("user_id")
          .where("space_id", "=", spaceId)
          .execute()
      ).map((row) => row.user_id),
    );
    // Org-baseline readers lose access; the roster retains. Space-
    // grant holders also retain but are over-closed here — accepted
    // bluntness on a rare admin verb.
    return (await liveWorkspaceMembers(workspace))
      .filter((id) => !retained.has(id))
      .map((user_id) => ({ kind: "user", user_id }));
  };

  const REVOKE_CLASS: ReadonlyMap<string, Extractor> = new Map([
    ["permission.revoke", grantEdgeSubject],
    ["doc.remove_guest", grantEdgeSubject],
    ["space.member_remove", memberSubject],
    ["space.member_update_role", memberSubject],
    // workspace.member_remove also closes the removed owner's live agents
    // (ADR 0044 Decision 2) — a dedicated extractor, not the shared one.
    ["workspace.member_remove", workspaceMemberRemoveSubjects],
    ["workspace.member_update_role", memberSubject],
    ["space.archive", spaceArchiveSubjects],
    ["doc.move", moveCrossingSubjects],
    ["collection.move", moveCrossingSubjects],
    ["space.update", spaceTypeNarrowingSubjects],
    // ADR 0044 Decision 5 agent derivations.
    ["agent.revoke", agentRevokeSubject],
    ["agent.token_revoke", tokenRevokeSubject],
  ]);

  return {
    async afterCommit(invocation, output) {
      const extract = REVOKE_CLASS.get(invocation.capability_id);
      const isDocDelete = invocation.capability_id === "doc.delete";
      if (extract === undefined && !isDocDelete) return;
      try {
        let closed = 0;
        if (extract !== undefined) {
          const affected = await extract(invocation, output);
          for (const target of affected) {
            switch (target.kind) {
              case "user":
                closed += registry.closeByUser(target.user_id);
                break;
              case "agent":
                closed += registry.closeByAgent(target.agent_id);
                break;
              case "token":
                closed += registry.closeByToken(target.token_id);
                break;
            }
          }
        }
        if (isDocDelete) {
          const parsed = DocDeleteOutputSchema.safeParse(output);
          if (!parsed.success) throw new Error("output carries no doc_id");
          if (closeDocConnections === undefined) {
            throw new Error("doc-close arm unwired (closeDocConnections missing)");
          }
          closed += closeDocConnections(parsed.data.doc_id);
        }
        if (closed > 0) {
          logger.info("collab feeds closed after revoke-class commit", {
            event: "session.revoke_close",
            "capability.id": invocation.capability_id,
            "collab.sockets_closed": closed,
          });
        }
      } catch (error) {
        // Liveness gap, not correctness — the mutation committed.
        logger.error("revocation tap failed; sockets may linger until next refused write", {
          event: "session.revoke_close",
          "capability.id": invocation.capability_id,
          "collab.reason": error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/**
 * Wrap a dispatcher so successful dispatches flow through the tap.
 * Refusals/throws pass through untouched (nothing committed, nothing
 * to revoke); the tap itself never throws into the caller.
 */
export function withRevocationTap(dispatcher: Dispatcher, tap: RevocationTap): Dispatcher {
  return {
    dispatch: async (invocation) => {
      const output = await dispatcher.dispatch(invocation);
      await tap.afterCommit(invocation, output);
      return output;
    },
    deps: dispatcher.deps,
  };
}
