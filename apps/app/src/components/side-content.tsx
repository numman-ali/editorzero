import { Link } from "@tanstack/react-router";

import { describePrincipal } from "../lib/principal";
import type { WhoamiSession } from "../lib/session";
import { type WorkspaceGet, workspaceMonogram } from "../lib/workspace";

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
 * there is nothing to switch to and the block is non-interactive.
 */
export function SideContent({
  session,
  workspace,
  onNavigate,
}: {
  session: WhoamiSession;
  workspace: WorkspaceGet;
  onNavigate?: () => void;
}) {
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
        <div className="ws">
          <span className="av av--u" aria-hidden="true">
            {workspaceMonogram(workspace.name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="nm">{workspace.name}</div>
            <div className="sub">{workspace.slug}</div>
          </div>
        </div>
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
      </nav>
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
