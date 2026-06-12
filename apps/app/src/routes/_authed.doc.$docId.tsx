import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { DocEditor } from "../components/doc-editor";
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
 * The panel header shows `doc.title` read-only — the title row is
 * `doc.rename`'s capability (its UI cell is a later slice). Until that
 * cell lands, editing the heading-1 block here updates the CONTENT
 * heading but not `docs.title` (list/breadcrumb keep the row value) —
 * an accepted, documented v1 seam, same one the API/CLI/MCP surfaces
 * already expose.
 *
 * Coverage: render-only; proven by the marked Playwright spec
 * (`packages/e2e/test/editor.spec.ts`, `proves-capability-cell:
 * doc.get` + `doc.update`).
 */
export const Route = createFileRoute("/_authed/doc/$docId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(docQueryOptions(params.docId)),
  component: DocScreen,
});

function DocScreen() {
  const { docId } = Route.useParams();
  const { data } = useSuspenseQuery(docQueryOptions(docId));
  return (
    <section className="panel" aria-labelledby="doc-heading">
      <div className="ph">
        <h2 className="t" id="doc-heading">
          {data.doc.title}
        </h2>
        <span className="pth">{data.doc.slug}</span>
      </div>
      <DocEditor key={docId} docId={docId} initialBlocks={data.blocks} />
    </section>
  );
}
