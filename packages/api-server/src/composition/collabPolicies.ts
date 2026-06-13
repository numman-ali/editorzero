/**
 * The collab WebSocket policy pair (ADR 0030 + ADR 0043) — the ONLY
 * place WS-borne identity and authority are decided.
 *
 * `getApiApp` builds these and hands them to `HocuspocusSync`:
 *
 *   - `collabAuthorize` → `onAuthenticate` (per (socket, documentName)
 *     Auth frame): attach-time standing — the same two terms the
 *     dispatcher gate would apply to `doc.get`, REUSED not
 *     re-implemented (invariant 5).
 *   - `collabApplyUpdate` → the `beforeHandleMessage` write gate (per
 *     NOVEL update-bearing frame): re-resolve the principal, dispatch
 *     `doc.apply_update`. Permission check, validation, audit row,
 *     `doc_updates` row, and the post-commit broadcast all run inside
 *     the dispatcher — exactly like an HTTP call. A throw refuses the
 *     frame and the per-document connection closes (the gate logs the
 *     reason).
 *
 * Both arms resolve identity through ONE `resolveCollabPrincipal` over
 * the composed bearer+cookie core (ADR 0044 Decision 5 step 2): a
 * session cookie → human, an `Authorization: Bearer ez_agent_…` →
 * api-key agent. Attach-time standing and per-frame write dispatch can
 * never diverge on identity (same resolve), and neither can the HTTP
 * surface (same core). Delegated (agent-auth) agents are refused until
 * the H8-aware arm lands — see `resolveCollabPrincipal`. Resolution
 * happens from the upgrade request's headers on EVERY call (revocation
 * freshness — nothing identity-shaped rides the connection).
 *
 * **`wireDispatcher` is late binding, not optional wiring.**
 * `HocuspocusSync` must exist before `createApiDispatcher` (the
 * dispatcher writes through sync), so the write policy closes over a
 * ref the composition root assigns right after construction —
 * synchronously, before `getApiApp` returns, and WS upgrades only
 * attach to a returned `BootedApp`. The unwired guard is fail-closed
 * for any path that somehow dispatches earlier.
 */

import { loadDocReadResolver } from "@editorzero/capabilities";
import type { SqliteDriver } from "@editorzero/db";
import { type Dispatcher, effectiveScopes } from "@editorzero/dispatcher";
import { CapabilityId, DocId } from "@editorzero/ids";
import type { Logger } from "@editorzero/observability";
import type { Principal } from "@editorzero/principal";
import type { CollabApplyUpdatePayload, CollabAuthorizePayload } from "@editorzero/sync";

import type { ComposedPrincipalResolver } from "../middleware/agent-bearer";

export interface CollabPoliciesDeps {
  /**
   * The composed bearer+cookie principal resolve (ADR 0044 Decision 5
   * step 2 / Codex SF2) — the SAME header-shaped core the HTTP principal
   * middleware uses, so attach standing, per-frame write authority, and
   * the HTTP surface can never diverge on identity. Cookie → human;
   * `Authorization: Bearer ez_agent_…` → api-key agent.
   */
  readonly resolvePrincipal: ComposedPrincipalResolver;
  /** The booted driver — doc lookups run tenant-scoped through it. */
  readonly driver: SqliteDriver;
  /** Structured logger for authorization denials. */
  readonly logger: Logger;
}

export interface CollabPolicies {
  readonly collabAuthorize: (payload: CollabAuthorizePayload) => Promise<void>;
  readonly collabApplyUpdate: (payload: CollabApplyUpdatePayload) => Promise<void>;
  /** Late-bind the dispatcher the write policy dispatches through. */
  readonly wireDispatcher: (dispatcher: Pick<Dispatcher, "dispatch">) => void;
}

export function createCollabPolicies(deps: CollabPoliciesDeps): CollabPolicies {
  const { resolvePrincipal, driver, logger } = deps;

  /**
   * The collab principal resolve both policies share (attach-time +
   * per-frame), over the composed bearer+cookie core. Forwards BOTH the
   * cookie and the `Authorization` header; the core decides the lane
   * (bearer wins, no cookie fallback on an explicit bearer).
   *
   * **Admits humans and api-key agents only.** A DELEGATED (agent-auth)
   * agent is refused: its real authority is `acting_as ∩ delegator`
   * (H8), an intersection `effectiveScopes` does NOT compute — for any
   * agent it returns the token's scope claim verbatim (see the gate.ts
   * caution). `collabAuthorize` leans on `effectiveScopes`, so admitting
   * a delegated agent here would grant it its UN-intersected token
   * scopes. The delegated WS arm — which must bring the H8-aware term —
   * is a later increment; until it lands, refuse rather than over-grant.
   * This is the rail that replaced the old cookie-only `kind !== "user"`
   * guard (ADR 0044 Decision 5 step 2).
   */
  const resolveCollabPrincipal = async (
    requestHeaders: CollabAuthorizePayload["requestHeaders"],
  ): Promise<Principal> => {
    const headers = new Headers();
    if (typeof requestHeaders.cookie === "string") {
      headers.set("cookie", requestHeaders.cookie);
    }
    if (typeof requestHeaders.authorization === "string") {
      headers.set("authorization", requestHeaders.authorization);
    }
    const principal = await resolvePrincipal(headers);
    if (principal === null) {
      throw new Error("collab: no authenticated principal");
    }
    if (principal.kind === "agent" && principal.token_kind !== "api-key") {
      throw new Error("collab: delegated agent tokens are not admitted on the WS surface yet");
    }
    return principal;
  };

  /**
   * Per-document WS authorization (ADR 0030 blockers 1–3). Runs once
   * per (socket, documentName) Auth frame; ANY throw denies that one
   * document attach — Hocuspocus answers a generic `permission-denied`
   * frame, so refusal reasons stay server-side (the structured warn
   * below is the observable channel).
   *
   * Authority = the gate's `effectiveScopes` arithmetic (`doc:read`),
   * then the Step-6 ceiling (`loadDocReadResolver(...).assertCanRead`)
   * on the live doc row. Soft-deleted docs deny: live collaboration on
   * a trashed doc is not a state the product has — restore first (ADR
   * 0017's recovery capability is the sanctioned route back).
   */
  const collabAuthorize = async ({
    documentName,
    requestHeaders,
  }: CollabAuthorizePayload): Promise<void> => {
    try {
      const principal = await resolveCollabPrincipal(requestHeaders);
      if (!effectiveScopes(principal).has("doc:read")) {
        throw new Error("collab: principal lacks doc:read");
      }
      const doc_id = DocId(documentName);
      const scoped = driver.scoped(principal.workspace_id);
      const doc = await scoped
        .selectFrom("docs")
        .select(["id", "created_by", "access_mode", "collection_id", "deleted_at"])
        .where("id", "=", doc_id)
        .executeTakeFirst();
      if (doc === undefined || doc.deleted_at !== null) {
        throw new Error("collab: document not found in principal workspace");
      }
      const acl = await loadDocReadResolver(scoped, principal);
      acl.assertCanRead(doc);
    } catch (error) {
      logger.warn("collab attach denied", {
        event: "hocuspocus.authenticate",
        "collab.document": documentName,
        "collab.reason": error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  let dispatcherRef: Pick<Dispatcher, "dispatch"> | null = null;

  const collabApplyUpdate = async ({
    documentName,
    requestHeaders,
    update,
  }: CollabApplyUpdatePayload): Promise<void> => {
    if (dispatcherRef === null) {
      throw new Error("collab: dispatcher not wired yet (boot in progress)");
    }
    const principal = await resolveCollabPrincipal(requestHeaders);
    await dispatcherRef.dispatch({
      capability_id: CapabilityId("doc.apply_update"),
      input: { doc_id: documentName, update },
      principal,
      access: { workspace_id: principal.workspace_id },
      trace_id: null,
    });
  };

  return {
    collabAuthorize,
    collabApplyUpdate,
    wireDispatcher: (dispatcher) => {
      dispatcherRef = dispatcher;
    },
  };
}
