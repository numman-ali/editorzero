import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import {
  auditListInfiniteOptions,
  auditOutcomeTagClass,
  auditPrincipalLabel,
  auditSubjectLabel,
  formatAuditTime,
} from "../lib/audit";

/**
 * `/audit` — the workspace trail: the `audit.list × Web UI` parity cell
 * (invariant 4, ADR 0033 §3 / 0040 H11), and the app's first
 * cursor-paginated screen. SINGULAR route on purpose: `/audits` is the
 * trunk's API domain and a reserved prefix (ADR 0035 §2) — the `/space`
 * + `/doc` + `/workspace` precedent.
 *
 * The loader warms the FIRST page (`ensureInfiniteQueryData`); "Load
 * more" appends pages through the wire cursor until `next_cursor: null`
 * ends the trail (the lib's `getNextPageParam` chains it verbatim).
 * Newest first — the head of the trail is the operational question.
 *
 * Both audit capabilities require `workspace:admin`. The nav entry is
 * unconditional because today's only browser principal IS the genesis
 * owner (the registration gate, ADR 0041); when multi-member arrives,
 * role-aware nav comes with it (punch list).
 *
 * Markup is the Meridian Zero `.panel` + `.tt` table vocabulary (the
 * documents-list pattern); ids render abbreviated here and in full on
 * the detail screen. Coverage: render-only — every decision (page size,
 * cursor chaining, labels, chips, UTC timestamps) lives unit-tested in
 * `lib/audit.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/trail.spec.ts`, `proves-capability-cell:
 * audit.list`).
 */
export const Route = createFileRoute("/_authed/audit/")({
  loader: ({ context }) => context.queryClient.ensureInfiniteQueryData(auditListInfiniteOptions()),
  component: AuditScreen,
});

function AuditScreen() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery(
    auditListInfiniteOptions(),
  );
  const events = data.pages.flatMap((page) => page.events);
  return (
    <section className="panel" aria-labelledby="audit-heading">
      <div className="ph">
        <h2 className="t" id="audit-heading">
          Audit
        </h2>
        <span className="pth">workspace trail · newest first · UTC</span>
      </div>
      {events.length === 0 ? (
        <p className="ord" style={{ padding: "15px" }}>
          No events recorded.
        </p>
      ) : (
        <table className="tt">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Capability</th>
              <th scope="col">Outcome</th>
              <th scope="col">Subject</th>
              <th scope="col">Principal</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="when">{formatAuditTime(event.created_at)}</td>
                <td>
                  <div className="doc">
                    <Link className="nm" to="/audit/$auditId" params={{ auditId: event.id }}>
                      {event.capability_id}
                    </Link>
                    {event.collapsed_count > 1 && (
                      <span className="when">×{event.collapsed_count}</span>
                    )}
                  </div>
                </td>
                <td>
                  <span className={auditOutcomeTagClass(event.outcome)}>{event.outcome}</span>
                </td>
                <td className="when">{auditSubjectLabel(event)}</td>
                <td className="when">{auditPrincipalLabel(event)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ padding: "15px" }}>
        {hasNextPage ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        ) : (
          <span className="ord">End of trail.</span>
        )}
      </div>
    </section>
  );
}
