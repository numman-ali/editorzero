import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { docQueryKey } from "../lib/doc-editor";
import { DOC_LIST_QUERY_KEY, publishDoc, publishFailureMessage, unpublishDoc } from "../lib/docs";

import "./inline-form.css";

/**
 * The `doc.publish` + `doc.unpublish × Web UI` cells: the doc screen's
 * panel-header publish toggle. Publish is DOC-LEVEL state orthogonal to
 * content (ADR 0040 Step 5) — which is why this lives in the header
 * next to title + slug, not in the editor toolbar with the content
 * verbs, and why success only invalidates the doc.get/doc.list caches
 * (the canvas is untouched; no re-base, no dirty-state interaction).
 *
 * Published state shows the MINTED `published_slug` (collision-suffixed
 * at first-publish, so not necessarily the doc slug) as status text —
 * the public reader route is a later slice, so there is no URL to link
 * yet; the list's green chip is the other visible effect. No confirm
 * step: both directions are one click apart and re-publish after an
 * unpublish simply re-mints (the slot may have been claimed — that is
 * the documented release-the-URL semantic, not data loss).
 *
 * Coverage: orchestration-only — the wire calls live unit-tested in
 * `lib/docs.ts`; this file is in the e2e-covered set, proven by the
 * marked Playwright spec (`packages/e2e/test/editor.spec.ts`).
 */

type PublishState = { kind: "idle" } | { kind: "busy" } | { kind: "failed" };

export function PublishDoc({
  docId,
  publishedSlug,
}: {
  docId: string;
  publishedSlug: string | null;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<PublishState>({ kind: "idle" });
  const direction = publishedSlug === null ? "publish" : "unpublish";

  async function handleToggle(): Promise<void> {
    if (state.kind === "busy") return;
    setState({ kind: "busy" });
    try {
      if (publishedSlug === null) {
        await publishDoc(docId);
      } else {
        await unpublishDoc(docId);
      }
      await queryClient.invalidateQueries({ queryKey: docQueryKey(docId) });
      await queryClient.invalidateQueries({ queryKey: DOC_LIST_QUERY_KEY });
      setState({ kind: "idle" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  const busy = state.kind === "busy";
  return (
    <span className="inlineform">
      {publishedSlug !== null ? (
        <span className="inlineform-status">published · {publishedSlug}</span>
      ) : null}
      <button
        type="button"
        className={publishedSlug === null ? "btn btn--ultra btn--sm" : "btn btn--ghost btn--sm"}
        onClick={() => void handleToggle()}
        disabled={busy}
      >
        {busy ? "Working…" : publishedSlug === null ? "Publish" : "Unpublish"}
      </button>
      {state.kind === "failed" ? (
        <span className="inlineform-err" role="alert">
          {publishFailureMessage(direction)}
        </span>
      ) : null}
    </span>
  );
}
