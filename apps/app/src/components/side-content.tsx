import { Link } from "@tanstack/react-router";

import { type CollectionSummary, flattenCollectionTree, treeRowIndent } from "../lib/collections";
import { describePrincipal } from "../lib/principal";
import type { WhoamiSession } from "../lib/session";
import { type WorkspaceGet, workspaceMonogram } from "../lib/workspace";
import { NewCollection } from "./new-collection";

/**
 * Sidebar interior — one source for both hosts: the static desktop
 * `<aside class="side">` and the mobile nav Drawer (ADR 0037). Extracted so
 * the principal chip + nav cannot drift between the two renders.
 *
 * The primary nav carries ONLY screens that exist (the e2e honesty bar —
 * same rule that kept SSO buttons off the login). Today: the documents
 * list at `/` (the doc.list ui cell) and the Spaces screen at `/space`
 * (the space.list cell — singular route, `/spaces` is the reserved API
 * domain). The mock's remaining entries (Overview, Shared with me,
 * Trash) join as their routes + capability cells land (ADR 0040;
 * `UI_PENDING` in contract-tests governs).
 *
 * The workspace block under the lockup is the `workspace.get` cell — an
 * IDENTITY block, not the mock's switcher: the deployment IS one
 * workspace (ADR 0040 Model B — `workspaces` is the tenant root), so
 * there is nothing to switch to. Its ONE interaction is the link into
 * `/workspace` (the settings screen — the `workspace.update` cell).
 *
 * The Collections tree under the nav is the `collection.list` cell:
 * READ-ONLY rows at the bare-cell stage — there is no collection screen
 * to link to, and drag-reorder is its own later cell (ADR 0037's Owned
 * Tree note budgets it; it binds collection.move/doc.move). Always
 * expanded — the `.tw` caret marks rows that HAVE children, it is not a
 * toggle yet. The section HEADER (inside `NewCollection`, the
 * `collection.create` cell) renders always — with a create affordance,
 * an empty workspace is a starting point — while the tree `<nav>`
 * itself stays absent until rows exist (the honesty bar applies to
 * navigation, and the rows are the navigation).
 */
export function SideContent({
  session,
  workspace,
  collections,
  onNavigate,
}: {
  session: WhoamiSession;
  workspace: WorkspaceGet;
  collections: readonly CollectionSummary[];
  onNavigate?: () => void;
}) {
  const tree = flattenCollectionTree(collections);
  const principal = describePrincipal(session);
  const avatarClass = principal.kind === "agent" ? "av av--agent" : "av av--u";
  return (
    <>
      <div className="top">
        <div className="logo">
          <span className="mark" aria-hidden="true">
            <span className="cross" />
            <span className="cross-ring" />
          </span>
          <span className="word">
            editor<b>zero</b>
          </span>
        </div>
        <Link className="ws" to="/workspace" onClick={onNavigate}>
          <span className="av av--u" aria-hidden="true">
            {workspaceMonogram(workspace.name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="nm">{workspace.name}</div>
            <div className="sub">{workspace.slug}</div>
          </div>
        </Link>
      </div>
      <nav className="nav" aria-label="Primary">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          activeProps={{ className: "on", "aria-current": "page" }}
          onClick={onNavigate}
        >
          <span className="ic" aria-hidden="true">
            ▤
          </span>
          All Documents
        </Link>
        <Link
          to="/space"
          activeProps={{ className: "on", "aria-current": "page" }}
          onClick={onNavigate}
        >
          <span className="ic" aria-hidden="true">
            ◫
          </span>
          Spaces
        </Link>
        <Link
          to="/audit"
          activeProps={{ className: "on", "aria-current": "page" }}
          onClick={onNavigate}
        >
          <span className="ic" aria-hidden="true">
            ≣
          </span>
          Audit
        </Link>
      </nav>
      <NewCollection />
      {tree.length > 0 && (
        <nav className="tree" aria-label="Collections">
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {tree.map((node) => {
              const indent = treeRowIndent(node.depth);
              return (
                <li key={node.id}>
                  {/* The whole row is the link (the `.tree .row`
                      hover/cursor tokens anticipated it); activeProps
                      MERGE `on` onto the base row classes. */}
                  <Link
                    className={indent.className}
                    to="/collection/$collectionId"
                    params={{ collectionId: node.id }}
                    activeProps={{ className: "on", "aria-current": "page" }}
                    onClick={onNavigate}
                    {...(indent.padding !== undefined && {
                      style: { paddingLeft: indent.padding },
                    })}
                  >
                    {node.hasChildren && (
                      <span className="tw" aria-hidden="true">
                        ▾
                      </span>
                    )}
                    <span className="ic" aria-hidden="true">
                      ▯
                    </span>
                    {node.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      <div className="foot">
        <span className={avatarClass} aria-hidden="true">
          {principal.monogram}
        </span>
        <div>
          <div className="nm">{principal.label}</div>
          <div className="rl">{principal.detail}</div>
        </div>
      </div>
    </>
  );
}
