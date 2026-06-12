/**
 * The audited-WS-write-lane gate (ADR 0043 Decision 3 — Shape B).
 *
 * Registered as Hocuspocus's `beforeHandleMessage` hook by
 * `HocuspocusSync`. The hook fires once per inbound WS frame on an
 * ESTABLISHED per-document connection, BEFORE the native
 * `MessageReceiver` applies it; a rejection makes
 * `Connection.handleMessage` close that per-document connection
 * (verified in the pinned 3.4.4 source — see the version-pin test).
 * It never fires for the dispatcher's `DirectConnection`s
 * (`openDirectConnection` constructs no `Connection`), so HTTP-path
 * writes cannot re-enter the gate.
 *
 * Total classification (review SHOULD-FIX 1): every frame a client can
 * send is affirmatively classified — pass, update-bearing, or refused.
 * Anything unclassifiable (unknown message type, unknown sync subtype,
 * malformed bytes) refuses, which closes the connection. The native
 * receiver would IGNORE unknown types (`console.error` + fall-through
 * in `MessageReceiver.apply`); the gate turns that silent tolerance
 * into closure.
 *
 * Update-bearing frames (`SyncStep2` / `Update`, under both `Sync` and
 * `SyncReply` envelopes) gate as follows:
 *
 *   1. `connection.readOnly` → pass through untouched. The native
 *      readOnly lanes keep their shipped contract (contained SyncStep2
 *      acks `syncStatus(true)`, novel writes nack `false`, nothing
 *      applies). This is NOT an authorization check — it is protocol
 *      coherence: a readOnly connection's writes must stay
 *      nacked-not-applied, never committed-while-nacked. Production
 *      attaches readOnly until ADR 0043 increment 5 (socket registry +
 *      revocation tap) lifts it; the dispatch arm below is the lifted
 *      lane.
 *   2. Contained-ness preflight — `Y.snapshotContainsUpdate` against
 *      the resident doc (the exact call the native readOnly SyncStep2
 *      arm makes). Sync-handshake chatter (re-sent state, empty
 *      SyncStep2 replies) skips dispatch entirely, so it cannot become
 *      audit spam (review MUST-FIX 2). The residual race — another
 *      writer commits the same delta between preflight and dispatch —
 *      lands in `doc.apply_update`'s marked no-op lane.
 *   3. Novel payload → `collabApplyUpdate` (the composition root's
 *      policy: re-resolve the principal from the upgrade headers,
 *      dispatch `doc.apply_update`). Resolve = the delta is COMMITTED
 *      and already applied to the resident; the native apply that runs
 *      after the hook is a Yjs structural no-op (no second event, no
 *      second broadcast) and acks `syncStatus(true)` honestly. Throw =
 *      refusal ⇒ the connection closes — a client pushing writes it
 *      lacks standing for loses the socket (also the revocation
 *      posture).
 *
 * **Per-connection ordering.** `Connection.handleMessage` does NOT
 * serialise hook invocations — each frame's hook fires as the frame
 * arrives, so two quick updates A→B from one client would dispatch
 * concurrently, and B (causally dependent on A via the client's Yjs
 * clock) could clone a resident that lacks uncommitted A and refuse
 * `not_integrable`. The gate therefore chains frames per connection:
 * frame N+1's classification starts only after frame N's gate settled
 * — and the native apply of frame N runs even before that (its
 * `.then` was registered first), so N+1's preflight always sees N in
 * the resident. Cross-connection writes stay concurrent (clients can
 * only depend on state they received, which is post-commit by
 * construction). A rejected chain stays rejected: every later frame on
 * a condemned connection refuses too (the close is already in flight;
 * latching is fail-closed and free).
 *
 * `BroadcastStateless` is refused outright (review SHOULD-FIX 2): an
 * unaudited cross-client relay inside an authorized room that nothing
 * in the product sends. Plain `Stateless` passes — with no
 * `onStateless` hook registered it is inert server-side. Awareness
 * stays unaudited (ephemeral presence, outside document state).
 */

import type { Logger } from "@editorzero/observability";
import { noopLogger } from "@editorzero/observability";
import type { beforeHandleMessagePayload } from "@hocuspocus/server";
import { MessageType } from "@hocuspocus/server";
import { createDecoder, readVarString, readVarUint, readVarUint8Array } from "lib0/decoding";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";

import { bytesToBase64 } from "./foreign-update";

/**
 * What the composition root's write policy receives per novel
 * update-bearing frame. `documentName` / `requestHeaders` are the same
 * fields `CollabAuthorizePayload` carries (the ORIGINAL upgrade
 * request's headers, re-presented per frame — the policy re-resolves
 * the principal from them every time; nothing identity-shaped rides
 * the connection). `update` is the extracted Yjs payload as base64 —
 * the exact wire shape of `doc.apply_update`'s `update` input, NOT the
 * raw WS frame.
 */
export type CollabApplyUpdatePayload = Pick<
  beforeHandleMessagePayload,
  "documentName" | "requestHeaders"
> & {
  readonly update: string;
};

/**
 * The structural slice of `beforeHandleMessagePayload` the gate reads —
 * unit tests fake it with a plain object + bare `Y.Doc`. CAUTION on
 * names: `update` here is Hocuspocus's field for the RAW inbound frame
 * (doc name + type + payload), not a Yjs update; `document` is the
 * resident doc (`Document extends Y.Doc`), used only for the
 * contained-ness preflight.
 */
export type CollabGatePayload = Pick<
  beforeHandleMessagePayload,
  "documentName" | "requestHeaders" | "update"
> & {
  readonly connection: { readonly readOnly: boolean };
  readonly document: Y.Doc;
};

/**
 * Total classification of an inbound WS frame. `frame` is the
 * server-side label (logs + tests); refusal details never reach the
 * client (Hocuspocus sends a generic reset reason).
 */
export type WsFrameClass =
  | { readonly kind: "pass"; readonly frame: string }
  | {
      readonly kind: "update";
      readonly frame: "sync-step2" | "sync-update";
      readonly update: Uint8Array;
    }
  | { readonly kind: "refuse"; readonly frame: string; readonly detail: string };

/**
 * Classify a raw inbound frame. Pure and TOTAL: malformed bytes
 * (truncated varints, oversized length prefixes) refuse rather than
 * throw — lib0 0.2.117's decoders are bounds-checked
 * (`errorUnexpectedEndOfArray` / `RangeError`), so the catch arm is
 * reachable but never loops.
 *
 * The envelope (`varString documentName` + `varUint messageType`)
 * mirrors `Connection.handleMessage` + `MessageReceiver.apply` in the
 * pinned source; the documentName is read only to advance the decoder
 * (handleMessage already dropped name-mismatched frames before the
 * hook). `SyncReply` classifies exactly like `Sync` — the native
 * receiver routes both through `readSyncMessage`.
 */
export function classifyWsFrame(data: Uint8Array): WsFrameClass {
  try {
    const decoder = createDecoder(data);
    readVarString(decoder);
    const type = readVarUint(decoder);
    switch (type) {
      case MessageType.Sync:
      case MessageType.SyncReply: {
        const sub = readVarUint(decoder);
        if (sub === messageYjsSyncStep1) {
          // A state-vector request; the server replies with state but
          // applies nothing.
          return { kind: "pass", frame: "sync-step1" };
        }
        if (sub === messageYjsSyncStep2) {
          return { kind: "update", frame: "sync-step2", update: readVarUint8Array(decoder) };
        }
        if (sub === messageYjsUpdate) {
          return { kind: "update", frame: "sync-update", update: readVarUint8Array(decoder) };
        }
        return {
          kind: "refuse",
          frame: `sync-${sub}`,
          detail: "unknown sync subtype (native readSyncMessage would throw)",
        };
      }
      case MessageType.Awareness:
        return { kind: "pass", frame: "awareness" };
      case MessageType.Auth:
        // Mid-session token sync (`onTokenSync`); the ESTABLISHING Auth
        // frame never reaches the hook (queued pre-connection).
        return { kind: "pass", frame: "auth" };
      case MessageType.QueryAwareness:
        return { kind: "pass", frame: "query-awareness" };
      case MessageType.Stateless:
        // Inert: no `onStateless` hook is registered server-side.
        return { kind: "pass", frame: "stateless" };
      case MessageType.CLOSE:
        return { kind: "pass", frame: "close" };
      case MessageType.BroadcastStateless:
        return {
          kind: "refuse",
          frame: "broadcast-stateless",
          detail: "unaudited cross-client relay (ADR 0043 Decision 3 shuts the channel)",
        };
      default:
        // Includes inbound SyncStatus (8) — a server→client type no
        // legitimate client sends — and anything newer than the pinned
        // protocol. The native receiver would silently ignore these.
        return {
          kind: "refuse",
          frame: `type-${type}`,
          detail: "no client-to-server handler for this message type",
        };
    }
  } catch (error) {
    return {
      kind: "refuse",
      frame: "malformed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CollabWriteGateDeps {
  /**
   * The composition root's write policy (see
   * `HocuspocusSyncDeps.collabApplyUpdate`). OPTIONAL with a
   * reject-all default — fail-closed by construction, mirroring the
   * deny-all `collabAuthorize` default: a `HocuspocusSync` composed
   * without a policy refuses novel WS writes (closing the connection)
   * rather than applying them unaudited.
   */
  readonly collabApplyUpdate?: (payload: CollabApplyUpdatePayload) => Promise<void>;
  /** Refusals log here (no silent failures). Defaults to noop. */
  readonly logger?: Logger;
}

/**
 * Build the `beforeHandleMessage` gate. One gate instance per
 * `HocuspocusSync`; per-connection ordering state lives in a WeakMap
 * keyed by the `Connection` object (one per socket × document), so it
 * dies with the connection.
 */
export function createCollabWriteGate(
  deps: CollabWriteGateDeps,
): (payload: CollabGatePayload) => Promise<void> {
  const collabApplyUpdate =
    deps.collabApplyUpdate ??
    (() =>
      Promise.reject(
        new Error("collab: no write policy configured (HocuspocusSyncDeps.collabApplyUpdate)"),
      ));
  const log = deps.logger ?? noopLogger;
  const chains = new WeakMap<object, Promise<void>>();

  async function gateFrame(payload: CollabGatePayload): Promise<void> {
    const classified = classifyWsFrame(payload.update);
    if (classified.kind === "pass") return;
    if (classified.kind === "refuse") {
      log.warn("collab frame refused", {
        event: "hocuspocus.write_gate",
        "collab.document": payload.documentName,
        "collab.frame": classified.frame,
        "collab.reason": classified.detail,
      });
      throw new Error(`collab: refused ${classified.frame} frame — ${classified.detail}`);
    }
    // Update-bearing. ReadOnly connections keep the native
    // nacked-not-applied contract (step 1 in the file header).
    if (payload.connection.readOnly) return;
    // Contained-ness preflight (step 2) — the same
    // `snapshotContainsUpdate` call the native readOnly arm makes.
    if (Y.snapshotContainsUpdate(Y.snapshot(payload.document), classified.update)) return;
    try {
      await collabApplyUpdate({
        documentName: payload.documentName,
        requestHeaders: payload.requestHeaders,
        update: bytesToBase64(classified.update),
      });
    } catch (error) {
      log.warn("collab write refused", {
        event: "hocuspocus.write_gate",
        "collab.document": payload.documentName,
        "collab.frame": classified.frame,
        "collab.reason": error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return (payload: CollabGatePayload): Promise<void> => {
    const prev = chains.get(payload.connection) ?? Promise.resolve();
    // Chain — not just sequence: a rejected predecessor short-circuits
    // this frame too (the connection is already condemned; latching is
    // fail-closed). `handleMessage` attaches a catch to every returned
    // promise, so the stored rejection is always handled.
    const next = prev.then(() => gateFrame(payload));
    chains.set(payload.connection, next);
    return next;
  };
}
