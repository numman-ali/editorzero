import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { DeleteCollection } from "../components/delete-collection";
import { EditCollection } from "../components/edit-collection";
import {
  collectionListQueryOptions,
  collectionSpaceLabel,
  docPlacementLabel,
} from "../lib/collections";
import { formatUpdated } from "../lib/docs";
import { spaceListQueryOptions } from "../lib/spaces";

/**
 * `/collection/$collectionId` — the collection detail screen: host of
 * the `collection.update` + `collection.delete × Web UI` cells
 * (invariant 4, ADR 0033 §3 / 0040 H11). SINGULAR route on purpose:
 * `/collections` is the trunk's API domain and a reserved prefix (ADR
 * 0035 §2) — the `/space` + `/doc` precedent. Reached from the sidebar
 * tree, whose rows become whole-row links with this screen (the
 * `.tree .row` hover/cursor tokens anticipated it).
 *
 * There is NO `collection.get` capability — by design, not as a gap:
 * the flat `collection.list` already carries every summary field, the
 * `_authed` layout warms it on every screen, and a per-id read would
 * duplicate that wire surface. The loader resolves the row from the
 * warmed list cache and maps an unknown id to notFound (a trashed
 * collection leaves the live list — same answer for a stale deep link).
 * The spaces list is warmed alongside it for the binding fact.
 *
 * Facts: binding (the space this collection is bound to, or the legacy
 * workspace bucket — the placement-policy pole `doc.move` keys on),
 * parent (the tree position), created/updated. The facts ARE the
 * closed state of the Edit disclosure (the EditSpace recipe).
 *
 * Coverage: render-only — decisions live unit-tested in
 * `lib/collections.ts`; proven by the marked Playwright spec
 * (`packages/e2e/test/collections.spec.ts`).
 */
export const Route = createFileRoute("/_authed/collection/$collectionId")({
  loader: async ({ context, params }) => {
    const [collections] = await Promise.all([
      context.queryClient.ensureQueryData(collectionListQueryOptions()),
      context.queryClient.ensureQueryData(spaceListQueryOptions()),
    ]);
    if (!collections.collections.some((c) => c.id === params.collectionId)) {
      throw notFound();
    }
  },
  notFoundComponent: CollectionNotFound,
  component: CollectionScreen,
});

function CollectionNotFound() {
  return (
    <section className="panel" aria-labelledby="collection-missing-heading">
      <div className="ph">
        <h2 className="t" id="collection-missing-heading">
          No such collection
        </h2>
      </div>
      <p className="ord" style={{ padding: "15px" }}>
        This collection is not in the live tree — it may have been trashed, or the link was
        mistyped. <Link to="/">Back to the docs.</Link>
      </p>
    </section>
  );
}

function CollectionScreen() {
  const { collectionId } = Route.useParams();
  const { data: collectionData } = useSuspenseQuery(collectionListQueryOptions());
  const { data: spaceData } = useSuspenseQuery(spaceListQueryOptions());
  const collection = collectionData.collections.find((c) => c.id === collectionId);
  if (collection === undefined) {
    // The row left the cache after load (trashed elsewhere mid-session)
    // — the same honest answer as a stale deep link.
    return <CollectionNotFound />;
  }
  return (
    <section className="panel" aria-labelledby="collection-heading">
      <div className="ph">
        <h2 className="t" id="collection-heading">
          {collection.title}
        </h2>
        <span className="pth">{collection.slug}</span>
      </div>
      <div style={{ padding: "15px" }}>
        <div className="kv">
          <span className="k">binding</span>
          <span className="v mono">
            {collectionSpaceLabel(collection.space_id, spaceData.spaces)}
          </span>
        </div>
        <div className="kv">
          <span className="k">parent</span>
          <span className="v mono">
            {docPlacementLabel(collection.parent_id, collectionData.collections)}
          </span>
        </div>
        <div className="kv">
          <span className="k">created</span>
          <span className="v mono">{formatUpdated(collection.created_at)}</span>
        </div>
        <div className="kv">
          <span className="k">updated</span>
          <span className="v mono">{formatUpdated(collection.updated_at)}</span>
        </div>
        <EditCollection collection={collection}>
          <DeleteCollection collectionId={collection.id} />
        </EditCollection>
      </div>
    </section>
  );
}
