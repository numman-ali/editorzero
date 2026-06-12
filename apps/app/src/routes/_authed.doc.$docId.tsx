import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { DocEditor } from "../components/doc-editor";
import { MoveDoc } from "../components/move-doc";
import { PublishDoc } from "../components/publish-doc";
import { collectionListQueryOptions, docPlacementLabel } from "../lib/collections";
import { docQueryOptions } from "../lib/doc-editor";

/**
 * `/doc/$docId` — the doc screen: the `doc.get` × Web UI parity cell
 * (load) hosting the `doc.update` cell (the editor's Save). Singular
 * `/doc` on purpose: `/docs` is a RESERVED API prefix
 * (`@editorzero/constants` — the trunk owns it for `/docs/list` etc.),
 * and client routes must never shadow the API namespace (ADR 0035 §2).
 *
 * The loader warms the cache (`ensureQueryData` — a 404/403 rejects
 * into the route error boundary before any chrome renders); the
 * component reads it back with `useSuspenseQuery`. `key={docId}`
 * remounts the editor across doc navigations — a Tiptap instance is
 * created once per mount, so reusing one across docs would leak state.
 *
 * The panel header shows `doc.title`; renaming it is the editor
 * toolbar's `RenameDoc` control (`doc.rename` — title + slug + the
 * canvas heading move together in ONE audited mutation; its re-base
 * writes the doc.get cache, so this header re-renders with no wiring
 * of its own). Editing the heading-1 block in the CANVAS remains a
 * content op that leaves `docs.title` behind — the documented v1 seam,
 * same as the API/CLI/MCP surfaces; the rename control is the
 * sanctioned path for browser users.
 *
 * Coverage: render-only; proven by the marked Playwright spec
 * (`packages/e2e/test/editor.spec.ts`, `proves-capability-cell:
 * doc.get` + `doc.update` + `doc.rename`).
 */
export const Route = createFileRoute("/_authed/doc/$docId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(docQueryOptions(params.docId)),
  component: DocScreen,
});

function DocScreen() {
  const { docId } = Route.useParams();
  const { data } = useSuspenseQuery(docQueryOptions(docId));
  // Layout-warmed cache; the placement label resolves collection_id to
  // a title (the doc.move cell made placement user-visible here).
  const { data: collectionData } = useQuery(collectionListQueryOptions());
  return (
    <section className="panel" aria-labelledby="doc-heading">
      <div className="ph">
        <h2 className="t" id="doc-heading">
          {data.doc.title}
        </h2>
        <span className="pth">{data.doc.slug}</span>
        <span className="ord">
          · {docPlacementLabel(data.doc.collection_id, collectionData?.collections ?? [])}
        </span>
        <div className="r">
          {/* Placement is doc-level state — Move lives here with
              title/slug, not in the editor toolbar (no canvas
              interaction; contrast rename). */}
          <MoveDoc docId={docId} currentCollectionId={data.doc.collection_id} />
          {/* Publish is doc-level state (orthogonal to content, ADR 0040
              Step 5) — it lives here with title + slug, not in the
              editor toolbar with the content verbs. */}
          <PublishDoc docId={docId} publishedSlug={data.doc.published_slug} />
        </div>
      </div>
      <DocEditor key={docId} docId={docId} docTitle={data.doc.title} initialBlocks={data.blocks} />
    </section>
  );
}
