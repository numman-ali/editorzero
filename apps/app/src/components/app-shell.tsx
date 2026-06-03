import type { ReactNode } from "react";

import { describePrincipal } from "../lib/principal";
import type { WhoamiSession } from "../lib/session";

/**
 * Authed shell chrome (ADR 0036 Meridian Zero / 0037). The strict 3-zone frame:
 * a sidebar (`<aside>` — brand lockup, primary nav, principal chip) and a main
 * column (`<header>` breadcrumb bar + `<main>` body). Presentational only — the
 * `_authed` route guard resolves the session before this renders, and passes it
 * in. Navigation, the Space switcher, search, the command palette, and the
 * responsive Drawer land in later #13 slices; this is the bare frame that proves
 * protected routing end-to-end under the Meridian Zero tokens.
 *
 * Coverage: exercised by the Playwright + axe e2e lane (ADR 0033), excluded from
 * vitest unit coverage like `routes/**`; the testable display logic lives in
 * `lib/principal.ts`.
 */
export function AppShell({ session, children }: { session: WhoamiSession; children: ReactNode }) {
  const principal = describePrincipal(session);
  const avatarClass = principal.kind === "agent" ? "av av--agent" : "av av--u";
  return (
    <div className="win">
      <aside className="side">
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
        </div>
        <nav className="nav" aria-label="Primary">
          {/* Primary navigation + the Space switcher land in the IA slice (#13). */}
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
      </aside>
      <div className="main">
        <header className="bar">
          <div className="crumb">
            <b>editorzero</b>
          </div>
        </header>
        <main className="body">{children}</main>
      </div>
    </div>
  );
}
