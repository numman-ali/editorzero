import { type Block, editorExtensions } from "@editorzero/blocks";
import { DOC_FRAGMENT } from "@editorzero/constants";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { Collaboration } from "@tiptap/extension-collaboration";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useReducer, useState } from "react";
import type * as Y from "yjs";

import {
  type CollabPhase,
  collabNoticeMessage,
  collabPhaseReducer,
  collabWsUrl,
  isTerminalPhase,
} from "../lib/collab";
import { docQueryOptions } from "../lib/doc-editor";
import { DocEditor } from "./doc-editor";
import { RenameDoc } from "./rename-doc";
import { TrashDoc } from "./trash-doc";

import "./doc-editor.css";

/**
 * The live collab editor — the `doc.apply_update × Web UI` cell
 * (ADR 0043: every WS delta dispatches through the audited write lane;
 * ADR 0038: the owned Tiptap layer binds the Y.Doc via
 * `@tiptap/extension-collaboration`).
 *
 * Session policy lives unit-tested in `lib/collab.ts`; this component
 * is the wiring: one Y.Doc + `HocuspocusProvider` per mount (the route
 * keys the mount by docId), callbacks dispatching into the phase
 * reducer, and a terminal-phase effect that destroys the provider —
 * which is what enforces ADR 0043's "re-auth, don't blind-retry" on a
 * 4401 and keeps a revoked feed from reconnect-storming.
 *
 * The canvas mounts ONLY after the first sync: a Tiptap instance bound
 * to a still-empty fragment would normalize the doc by inserting an
 * empty paragraph locally, and that junk block would sync UP the
 * moment the handshake lands — pre-sync there is nothing to edit, so
 * nothing is mounted that could mutate. (`token: null` — the cookie
 * authenticates the upgrade, ADR 0030; the Auth frame's token field is
 * unused server-side.)
 *
 * Fallback (`phase.kind === "fallback"`) renders the HTTP-first
 * `DocEditor` — WS unreachable or the operator's `collabReadOnly` pin
 * (WS writes would be silently nacked; `doc.update` + explicit Save
 * still works in that posture, so degrading beats a dead canvas). The
 * fallback re-bases from the route loader's cache; if live edits had
 * synced before the degrade, its first Save 409s into the existing
 * Reload arm — safe by the hash preconditions, never silent.
 *
 * Rename in collab mode needs no dirty-canvas gate and no content
 * re-base: `doc.rename` rewrites the heading server-side and the
 * rewrite arrives through the live broadcast like any other remote
 * edit; `onRenamed` only refreshes the `doc.get` cache so the panel
 * header re-renders.
 *
 * Coverage: orchestration-only — policy lives unit-tested in
 * `lib/collab.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/live-collab.spec.ts`).
 */

interface CollabSession {
  readonly ydoc: Y.Doc;
  readonly provider: HocuspocusProvider;
}

const PHASE_LABEL: Partial<Record<CollabPhase["kind"], string>> = {
  connecting: "Connecting live session…",
  live: "Live",
  paused: "Reconnecting…",
};

export function CollabDocEditor({
  docId,
  docTitle,
  initialBlocks,
}: {
  docId: string;
  docTitle: string;
  initialBlocks: readonly Block[];
}) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const [phase, dispatch] = useReducer(collabPhaseReducer, { kind: "connecting" });
  const [session, setSession] = useState<CollabSession | null>(null);
  const [everSynced, setEverSynced] = useState(false);

  useEffect(() => {
    // The disposed flag gates every callback: destroying a provider
    // fires its own close/status events, and under StrictMode's
    // double-invoked effects those death echoes would otherwise drive
    // the SECOND provider's phase into fallback before it ever
    // connected.
    let disposed = false;
    const provider = new HocuspocusProvider({
      url: collabWsUrl(window.location.origin),
      name: docId,
      token: null,
      onAuthenticated: ({ scope }) => {
        if (!disposed) dispatch({ kind: "authenticated", scope });
      },
      onAuthenticationFailed: () => {
        if (!disposed) dispatch({ kind: "auth_failed" });
      },
      onSynced: () => {
        if (!disposed) {
          setEverSynced(true);
          dispatch({ kind: "synced" });
        }
      },
      onStatus: ({ status }) => {
        if (!disposed) dispatch({ kind: "status", status });
      },
      onClose: ({ event }) => {
        if (!disposed) dispatch({ kind: "closed", code: event.code, reason: event.reason });
      },
    });
    setSession({ ydoc: provider.document, provider });
    return () => {
      disposed = true;
      setSession(null);
      // destroy() unhooks the provider but deliberately leaves the
      // Y.Doc alive (a terminal-phase canvas keeps rendering the
      // frozen content); the doc dies with the mount.
      provider.destroy();
      provider.document.destroy();
    };
  }, [docId]);

  // Terminal phases tear the transport down: a 4401 must never feed
  // the provider's built-in retry backoff (ADR 0043), and a fallback
  // canvas must not keep a half-dead socket around. The reducer
  // absorbs the destroy's own close echo.
  useEffect(() => {
    if (session !== null && isTerminalPhase(phase)) {
      session.provider.destroy();
    }
  }, [phase, session]);

  if (phase.kind === "fallback") {
    return <DocEditor key={`fallback-${docId}`} {...{ docId, docTitle, initialBlocks }} />;
  }

  const notice = collabNoticeMessage(phase);

  return (
    <div className="doc-editor">
      <div className="doc-editor-toolbar">
        <span className="doc-editor-status" role="status">
          {PHASE_LABEL[phase.kind] ?? ""}
        </span>
        <span className="doc-editor-spacer" />
        {/* No dirty-canvas gate (contrast the HTTP editor): the rename's
            canvas rewrite arrives through the live broadcast. Disabled
            until live so a rename can't race the first sync. */}
        <RenameDoc
          docId={docId}
          currentTitle={docTitle}
          disabled={phase.kind !== "live"}
          onRenamed={async () => {
            await queryClient.fetchQuery({ ...docQueryOptions(docId), staleTime: 0 });
          }}
        />
        <TrashDoc docId={docId} disabled={false} />
      </div>
      {notice !== null ? (
        <div className="doc-editor-alert" role="alert">
          <span>{notice}</span>
          {phase.kind === "session_revoked" ? (
            <Link
              className="btn btn--ghost btn--sm"
              to="/login"
              search={{ redirect: location.href }}
            >
              Sign in
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          )}
        </div>
      ) : null}
      {session !== null && everSynced ? (
        <CollabCanvas
          fragment={session.ydoc.getXmlFragment(DOC_FRAGMENT)}
          editable={phase.kind === "live"}
        />
      ) : notice === null ? (
        // Presentational only — the toolbar's role="status" already
        // announces the phase; a second status element would double
        // the live-region noise.
        <div className="doc-editor-connecting" aria-hidden="true">
          Connecting live session…
        </div>
      ) : null}
    </div>
  );
}

/**
 * The bound canvas — mounted only after the first sync (see the host's
 * docstring). Editability follows the phase: paused/terminal canvases
 * are read-only (ADR 0039 — local edits while disconnected would queue
 * into an offline-write lane this product does not have).
 */
function CollabCanvas({ fragment, editable }: { fragment: Y.XmlFragment; editable: boolean }) {
  const editor = useEditor({
    extensions: [...editorExtensions(), Collaboration.configure({ fragment })],
    editable,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        "aria-label": "Doc content",
        class: "edcanvas doc-editor-surface",
      },
    },
  });

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  return <EditorContent editor={editor} />;
}
