import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { spaceKindLabel, spaceListQueryOptions, spaceMetaLine } from "../lib/spaces";

/**
 * `/space` — the Spaces screen: the `space.list × Web UI` parity cell
 * (invariant 4, ADR 0033 §3 / 0040 H11). Same loader/component split as
 * the docs cell: `ensureQueryData` warms the cache (a failed list lands
 * in the route error boundary), `useSuspenseQuery` reads it back.
 *
 * SINGULAR route on purpose: `/spaces` is the trunk's API domain
 * (slice 2a) and therefore a reserved prefix (ADR 0035 §2) — the same
 * collision the editor route resolved with `/doc/$docId` vs `/docs`.
 * The ADR 0040 vocabulary lock binds the LABEL ("Space"/"Spaces", which
 * all copy here uses); its `/spaces` route suggestion predates the API
 * domain and is amended in the ADR's dated entries.
 *
 * Markup is the Meridian Zero `.spaces` grid + `.sp` card pattern from
 * the landed token sheet (02-spaces mock vocabulary) — zero new CSS.
 * Each card's NAME links into the space's detail screen
 * (`/space/$spaceId`, the `space.get` cell — the docs-table `.nm` Link
 * idiom); the grid renders wire order verbatim (`name ASC, id ASC` —
 * the capability's ordering contract, pinned server-side).
 *
 * Coverage: render-only by design — every decision (query options,
 * labels, the meta line) lives unit-tested in `lib/spaces.ts`; this
 * file is in the e2e-covered set, proven by the marked Playwright spec
 * (`packages/e2e/test/spaces.spec.ts`, `proves-capability-cell:
 * space.list`).
 */
export const Route = createFileRoute("/_authed/space/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(spaceListQueryOptions()),
  component: Spaces,
});

function Spaces() {
  const { data } = useSuspenseQuery(spaceListQueryOptions());
  const spaces = data.spaces;
  return (
    <section className="panel" aria-labelledby="spaces-heading">
      <div className="ph">
        <h2 className="t" id="spaces-heading">
          Spaces
        </h2>
      </div>
      {spaces.length === 0 ? (
        <p className="ord" style={{ padding: "15px" }}>
          No Spaces visible yet.
        </p>
      ) : (
        <ul className="spaces" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {spaces.map((space, index) => (
            <li className="sp" key={space.space_id}>
              <div className="ord">SP·{String(index + 1).padStart(2, "0")}</div>
              <div className="nm">
                {/* The anchor inherits the .nm display face (global
                    `a { color:inherit }`) — the block div keeps the
                    card's margin rhythm. */}
                <Link to="/space/$spaceId" params={{ spaceId: space.space_id }}>
                  {space.name}
                </Link>
              </div>
              <div className="ds">{space.slug}</div>
              <div className="ft">
                <span className="status-tag">{spaceKindLabel(space.kind)}</span>
                <span className="ord">{spaceMetaLine(space)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
