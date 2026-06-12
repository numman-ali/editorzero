import { Drawer } from "@base-ui/react/drawer";
import type { ReactNode } from "react";
import { useState } from "react";

import type { WhoamiSession } from "../lib/session";
import type { WorkspaceGet } from "../lib/workspace";
import { SideContent } from "./side-content";

import "./app-shell.css";

/**
 * Authed shell chrome (ADR 0036 Meridian Zero / 0037). The strict 3-zone
 * frame: a sidebar (`<aside>` — brand lockup, primary nav, principal chip)
 * and a main column (`<header>` breadcrumb bar + `<main>` body).
 * Presentational only — the `_authed` route guard resolves the session
 * before this renders, and passes it in.
 *
 * Responsive: under the token sheet's 1120px breakpoint the static aside
 * is hidden, so the SAME `SideContent` re-renders inside a Base UI Drawer
 * (ADR 0037's one-vendor-for-overlays rule; swipe-to-dismiss left). The
 * hamburger is the Drawer.Trigger — Base UI wires aria-haspopup/expanded/
 * controls on it and renders the popup as a named modal dialog (focus
 * trap + scroll lock + Escape). The Space switcher, search, command
 * palette, and further nav entries land with their capability cells.
 *
 * Coverage: exercised by the Playwright + axe e2e lane (ADR 0033;
 * `chrome.spec.ts` drives the drawer), excluded from vitest unit coverage
 * like `routes/**`; the testable display logic lives in `lib/principal.ts`.
 */
export function AppShell({
  session,
  workspace,
  children,
}: {
  session: WhoamiSession;
  workspace: WorkspaceGet;
  children: ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="win">
      <aside className="side">
        <SideContent session={session} workspace={workspace} />
      </aside>
      <div className="main">
        <header className="bar">
          <Drawer.Root swipeDirection="left" open={navOpen} onOpenChange={setNavOpen}>
            <Drawer.Trigger className="shell-burger" aria-label="Open navigation">
              <span aria-hidden="true">≡</span>
            </Drawer.Trigger>
            <Drawer.Portal>
              <Drawer.Backdrop className="shell-scrim" />
              <Drawer.Viewport className="shell-drawer-viewport">
                <Drawer.Popup className="shell-drawer">
                  <Drawer.Title className="sr-only">Navigation</Drawer.Title>
                  <Drawer.Content className="side">
                    <SideContent
                      session={session}
                      workspace={workspace}
                      onNavigate={() => setNavOpen(false)}
                    />
                  </Drawer.Content>
                </Drawer.Popup>
              </Drawer.Viewport>
            </Drawer.Portal>
          </Drawer.Root>
          <div className="crumb">
            <b>editorzero</b>
          </div>
        </header>
        <main className="body">{children}</main>
      </div>
    </div>
  );
}
