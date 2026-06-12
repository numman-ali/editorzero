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
 * Both arms resolve identity through ONE `resolveCollabPrincipal` —
 * cookie arm only today (user principals); ADR 0043 increment 4 grows
 * the `Authorization: Bearer` arm for api-key + delegated-agent
 * principals HERE, so attach-time standing and per-frame write
 * dispatch can never diverge on identity. Resolution happens from the
 * upgrade request's headers on EVERY call (revocation freshness —
 * nothing identity-shaped rides the connection).
 *
 * **`wireDispatcher` is late binding, not optional wiring.**
 * `HocuspocusSync` must exist before `createApiDispatcher` (the
 * dispatcher writes through sync), so the write policy closes over a
 * ref the composition root assigns right after construction —
 * synchronously, before `getApiApp` returns, and WS upgrades only
 * attach to a returned `BootedApp`. The unwired guard is fail-closed
 * for any path that somehow dispatches earlier.
 */

import type { BetterAuthResolver } from "@editorzero/auth";
import { loadDocReadResolver } from "@editorzero/capabilities";
import type { SqliteDriver } from "@editorzero/db";
import { type Dispatcher, effectiveScopes } from "@editorzero/dispatcher";
import { CapabilityId, DocId } from "@editorzero/ids";
import type { Logger } from "@editorzero/observability";
import type { Principal } from "@editorzero/principal";
import type { CollabApplyUpdatePayload, CollabAuthorizePayload } from "@editorzero/sync";

export interface CollabPoliciesDeps {
  /** The shared Better Auth resolver (one identity source, ADR 0030). */
  readonly resolver: BetterAuthResolver;
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
  const { resolver, driver, logger } = deps;

  /**
   * The collab principal resolve both policies share. Cookie arm only
   * today — `kind !== "user"` is a defensive rail for the increment-4
   * multi-principal resolver, not a reachable branch of the current
   * `BetterAuthResolver` type.
   */
  const resolveCollabPrincipal = async (
    requestHeaders: CollabAuthorizePayload["requestHeaders"],
  ): Promise<Principal> => {
    const headers = new Headers();
    if (typeof requestHeaders.cookie === "string") {
      headers.set("cookie", requestHeaders.cookie);
    }
    const principal = await resolver(headers);
    if (principal === null) {
      throw new Error("collab: no authenticated session");
    }
    if (principal.kind !== "user") {
      throw new Error("collab: cookie path admits user principals only");
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
