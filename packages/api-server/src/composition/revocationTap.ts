/**
 * The revocation tap (ADR 0043 Decision 5, review MUST-FIX 3) —
 * event-driven socket closes after revoke-class capability commits.
 *
 * `getApiApp` wraps the dispatcher so every SUCCESSFUL dispatch flows
 * through `afterCommit` (the SQL tx has committed and the resident
 * applied by the time `dispatch` resolves). For the revoke-class set
 * the tap derives the affected user(s) and closes their collab
 * sockets via the registry; everything else is a Map miss. The
 * Better Auth sign-out arm is separate (`onSessionRevoked` on
 * `createApiApp` → `closeBySession`).
 *
 * Affected-subject derivation per capability:
 *
 *   - `permission.revoke` / `doc.remove_guest` — the deleted edge is
 *     echoed verbatim in the output (`GrantRowOutputSchema`);
 *     user-kind subjects close. Agent-kind subjects have no sockets
 *     today — the WS bearer arm (ADR 0043 Decision 4, gated on the
 *     ADR 0016 credential slice) extends the registry keys when it
 *     lands.
 *   - `space.member_remove` / `space.member_update_role` /
 *     `workspace.member_remove` / `workspace.member_update_role` —
 *     the output echoes the affected `user_id`. Role UPDATES close
 *     too: a narrowed role must drop live read feeds the old role
 *     justified; re-attach re-runs `collabAuthorize` under the new
 *     standing.
 *   - `doc.delete` — no single subject in the envelope; the affected
 *     set is the doc's user-kind grant holders (guests), read from
 *     `grants` (rows survive soft-delete). Members keep standing via
 *     membership; their attachment to the trashed doc goes inert (no
 *     further broadcasts can commit), so only grant-scoped subjects
 *     close.
 *   - `space.archive` — the space's members (`space_members`), whose
 *     read standing to its docs flowed through the archived space.
 *   - `doc.move` / `collection.move` — a bucket CROSSING narrows read
 *     standing two ways, both derivable from the `acl_transition`
 *     echo (absent on same-bucket moves — those change no reader):
 *     `dropped_grants` preimages are revoked edges (the echo's own
 *     docstring calls it "the `permission.revoke` posture") — their
 *     user-kind subjects close; and the BEFORE bucket's
 *     placement-derived readers lose standing when the AFTER bucket
 *     does not cover them — the workspace root and open spaces keep
 *     every member readable, closed/private spaces do not, so the
 *     before-bucket readers (a space's members, or the workspace's
 *     members for the root bucket) close only on a move into a
 *     restrictive space. Over-close of readers who retain standing
 *     some other way is accepted bluntness — re-attach re-runs
 *     `collabAuthorize`, the authority.
 *
 * Named residual (ADR 0043 amendment): `space.update` can narrow
 * `space_type` (open → closed/private), revoking placement-derived
 * readers, but its output does not echo the BEFORE type, so narrowing
 * is indistinguishable from a rename here. The fix shape is a type
 * transition echo on the capability output (exactly how moves echo
 * `acl_transition`) — it joins this map with that widening.
 *
 * Outputs are narrowed through the SSOT zod schemas
 * (`@editorzero/schemas`) — never cast. A parse miss means the
 * capability's output shape drifted from this tap: that logs loud as
 * an error (drift guard) and closes nothing.
 *
 * **The tap never throws into the dispatch path.** The mutation is
 * durable by the time it runs; a tap failure is a liveness gap
 * (sockets linger until their next refused write), not a correctness
 * hole — log loud, return the output.
 */

import type { SqliteDriver } from "@editorzero/db";
import type { Dispatcher, DispatchInvocation } from "@editorzero/dispatcher";
import { SpaceId, UserId } from "@editorzero/ids";
import type { Logger } from "@editorzero/observability";
import { AclTransitionOutputSchema, GrantRowOutputSchema } from "@editorzero/schemas/shared/grant";
import { z } from "zod";

import type { CollabSocketRegistry } from "./collabSockets";

/** Output slice shared by the four membership ops — `user_id` is all the tap reads. */
const MemberOutputSchema = z.object({ user_id: z.string() }).loose();
const DocDeleteOutputSchema = z.object({ doc_id: z.string() }).loose();
const SpaceArchiveOutputSchema = z.object({ space_id: z.string() }).loose();
/** Output slice shared by both movers — the crossing receipt is all the tap reads. */
const MoveOutputSchema = z.object({ acl_transition: AclTransitionOutputSchema.optional() }).loose();

export interface RevocationTapDeps {
  readonly registry: CollabSocketRegistry;
  readonly driver: SqliteDriver;
  readonly logger: Logger;
}

export interface RevocationTap {
  /** Fire-and-contain: derives affected users, closes their sockets. */
  afterCommit(invocation: DispatchInvocation, output: unknown): Promise<void>;
}

export function createRevocationTap(deps: RevocationTapDeps): RevocationTap {
  const { registry, driver, logger } = deps;

  type Extractor = (invocation: DispatchInvocation, output: unknown) => Promise<UserId[]>;

  const grantEdgeSubject: Extractor = (_invocation, output) => {
    const parsed = GrantRowOutputSchema.safeParse(output);
    if (!parsed.success) return Promise.reject(new Error("output is not a grant row"));
    if (parsed.data.subject_kind !== "user") return Promise.resolve([]);
    return Promise.resolve([UserId(parsed.data.subject_id)]);
  };

  const memberSubject: Extractor = (_invocation, output) => {
    const parsed = MemberOutputSchema.safeParse(output);
    if (!parsed.success) return Promise.reject(new Error("output carries no user_id"));
    return Promise.resolve([UserId(parsed.data.user_id)]);
  };

  const docGuestSubjects: Extractor = async (invocation, output) => {
    const parsed = DocDeleteOutputSchema.safeParse(output);
    if (!parsed.success) throw new Error("output carries no doc_id");
    const rows = await driver
      .scoped(invocation.principal.workspace_id)
      .selectFrom("grants")
      .select("subject_id")
      .where("resource_kind", "=", "doc")
      .where("resource_id", "=", parsed.data.doc_id)
      .where("subject_kind", "=", "user")
      .execute();
    return rows.map((row) => UserId(row.subject_id));
  };

  const spaceMemberSubjects: Extractor = async (invocation, output) => {
    const parsed = SpaceArchiveOutputSchema.safeParse(output);
    if (!parsed.success) throw new Error("output carries no space_id");
    const rows = await driver
      .scoped(invocation.principal.workspace_id)
      .selectFrom("space_members")
      .select("user_id")
      .where("space_id", "=", SpaceId(parsed.data.space_id))
      .execute();
    return rows.map((row) => row.user_id);
  };

  const moveCrossingSubjects: Extractor = async (invocation, output) => {
    const parsed = MoveOutputSchema.safeParse(output);
    if (!parsed.success) throw new Error("output carries no recognizable move echo");
    const transition = parsed.data.acl_transition;
    // Same-bucket move: no crossing receipt, no reader change.
    if (transition === undefined) return [];
    const workspace = invocation.principal.workspace_id;
    const affected = new Set<UserId>();
    // Dropped grant edges are revocations regardless of placement
    // direction (`adopt_baseline` hard-deletes them; the echo carries
    // the preimages). Agent-kind subjects skip — no agent sockets.
    for (const grant of transition.dropped_grants) {
      if (grant.subject_kind === "user") affected.add(UserId(grant.subject_id));
    }
    // Placement-derived readers of the BEFORE bucket close only when
    // the AFTER bucket excludes them: the root bucket and open spaces
    // keep every workspace member readable; closed/private do not. A
    // missing after-space row reads as restrictive — fail toward
    // closing (re-attach is cheap; a leak is not).
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
      if (transition.before_space_id !== null) {
        const rows = await driver
          .scoped(workspace)
          .selectFrom("space_members")
          .select("user_id")
          .where("space_id", "=", transition.before_space_id)
          .execute();
        for (const row of rows) affected.add(row.user_id);
      } else {
        const rows = await driver
          .scoped(workspace)
          .selectFrom("workspace_members")
          .select("user_id")
          .where("deleted_at", "is", null)
          .execute();
        for (const row of rows) affected.add(row.user_id);
      }
    }
    return [...affected];
  };

  const REVOKE_CLASS: ReadonlyMap<string, Extractor> = new Map([
    ["permission.revoke", grantEdgeSubject],
    ["doc.remove_guest", grantEdgeSubject],
    ["space.member_remove", memberSubject],
    ["space.member_update_role", memberSubject],
    ["workspace.member_remove", memberSubject],
    ["workspace.member_update_role", memberSubject],
    ["doc.delete", docGuestSubjects],
    ["space.archive", spaceMemberSubjects],
    ["doc.move", moveCrossingSubjects],
    ["collection.move", moveCrossingSubjects],
  ]);

  return {
    async afterCommit(invocation, output) {
      const extract = REVOKE_CLASS.get(invocation.capability_id);
      if (extract === undefined) return;
      try {
        const affected = await extract(invocation, output);
        let closed = 0;
        for (const user_id of affected) {
          closed += registry.closeByUser(user_id);
        }
        if (closed > 0) {
          logger.info("collab sockets closed after revoke-class commit", {
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
