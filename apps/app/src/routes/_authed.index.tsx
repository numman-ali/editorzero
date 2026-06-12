import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { NewDoc } from "../components/new-doc";
import { docAccessModeLabel, docListQueryOptions, docTagClass, formatUpdated } from "../lib/docs";

/**
 * `/` — the Space landing: the `doc.list × Web UI` parity cell, plus the
 * `doc.create` cell's "+ New doc" affordance in the panel header
 * (invariant 4, ADR 0033 §3 / 0040 H11). The loader warms the query cache
 * before the screen renders (`ensureQueryData` — rejects on error, so a
 * failed list lands in the route error boundary, never a half-rendered
 * table), and the component reads it back with `useSuspenseQuery` — no
 * loading-state UI to design at the bare-cell stage; the Base UI chrome
 * slice owns that.
 *
 * Markup is the Meridian Zero `.panel` + `.tt` tabular-doc pattern straight
 * from the landed token sheet (03-documents mock vocabulary) — zero new
 * CSS. Vocabulary lock (ADR 0040): copy says "Space"; the wire call
 * underneath is `GET /docs/list` against the `/workspaces`-rooted tenancy.
 *
 * Coverage: render-only by design — every decision (query options, labels,
 * tag classes, date shape) lives unit-tested in `lib/docs.ts`; this file is
 * in the e2e-covered set, proven by the marked Playwright spec
 * (`packages/e2e/test/docs.spec.ts`, `proves-capability-cell: doc.list`).
 */
export const Route = createFileRoute("/_authed/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(docListQueryOptions()),
  component: Home,
});

function Home() {
  const { data } = useSuspenseQuery(docListQueryOptions());
  const docs = data.docs;
  return (
    <section className="panel" aria-labelledby="docs-heading">
      <div className="ph">
        <h2 className="t" id="docs-heading">
          Docs
        </h2>
        <div className="r">
          <NewDoc />
        </div>
      </div>
      {docs.length === 0 ? (
        <p className="ord" style={{ padding: "15px" }}>
          No docs in this Space yet.
        </p>
      ) : (
        <table className="tt">
          <thead>
            <tr>
              <th scope="col">Doc</th>
              <th scope="col">Access</th>
              <th scope="col" className="num">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc, index) => (
              <tr key={doc.id}>
                <td>
                  <div className="doc">
                    <span className="ord">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      {/* Singular /doc — /docs is the reserved API prefix. */}
                      <Link className="nm" to="/doc/$docId" params={{ docId: doc.id }}>
                        {doc.title}
                      </Link>
                      <div className="pth">{doc.slug}</div>
                    </div>
                  </div>
                </td>
                <td>
                  {/* Label = read scope (access_mode); green st-pub
                      modifier = the orthogonal publish dimension. */}
                  <span className={docTagClass(doc.published_at)}>
                    {docAccessModeLabel(doc.access_mode)}
                  </span>
                </td>
                <td className="num">
                  <span className="when">{formatUpdated(doc.updated_at)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
