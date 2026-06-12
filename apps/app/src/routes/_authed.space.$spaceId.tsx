import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { ArchiveSpace } from "../components/archive-space";
import { EditSpace } from "../components/edit-space";
import { spaceKindLabel, spaceQueryOptions } from "../lib/spaces";

/**
 * `/space/$spaceId` — the space detail screen: the `space.get × Web UI`
 * parity cell (invariant 4, ADR 0033 §3 / 0040 H11). Reached from the
 * Spaces grid (each card's name links here); same loader/component
 * split as every cell — `ensureQueryData` warms the cache (an invisible
 * or trashed space 404s into the route error boundary before any chrome
 * renders), `useSuspenseQuery` reads it back.
 *
 * The screen renders the row `space.get` returns verbatim: name + slug
 * in the panel header (the doc-screen idiom), the kind chip, then the
 * body — `EditSpace`, the `space.update` cell: the `.kv` fact rows
 * with the Edit disclosure that swaps them for the PATCH form. Owner /
 * created-by stay off-screen for now: they are raw user ids, and no
 * member-list capability exists yet to resolve them to names (the
 * punch-list roster gap) — rendering UUIDs would be noise, not
 * honesty.
 *
 * Coverage: render-only; decisions (query options, labels, the meta
 * line, date formatting) live unit-tested in `lib/spaces.ts` +
 * `lib/docs.ts`. Proven by the marked Playwright spec
 * (`packages/e2e/test/spaces.spec.ts`, `proves-capability-cell:
 * space.get`).
 */
export const Route = createFileRoute("/_authed/space/$spaceId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(spaceQueryOptions(params.spaceId)),
  component: SpaceScreen,
});

function SpaceScreen() {
  const { spaceId } = Route.useParams();
  const { data: space } = useSuspenseQuery(spaceQueryOptions(spaceId));
  return (
    <section className="panel" aria-labelledby="space-heading">
      <div className="ph">
        <h2 className="t" id="space-heading">
          {space.name}
        </h2>
        <span className="pth">{space.slug}</span>
        <div className="r">
          <span className="status-tag">{spaceKindLabel(space.kind)}</span>
        </div>
      </div>
      <EditSpace space={space}>
        {/* The space.archive cell — recoverable via space.restore
            (API/CLI/MCP; the archived-listing gap blocks a browser
            restore screen, the doc-trash punch-list class). */}
        <ArchiveSpace spaceId={spaceId} />
      </EditSpace>
    </section>
  );
}
