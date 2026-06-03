/**
 * Principal → shell-chrome display model (ADR 0036 Meridian Zero).
 *
 * `GET /infra/whoami` carries the *acting* principal but **no** name or email
 * (it is the dispatcher's authz view, not Better Auth's profile — `whoami.ts`),
 * so the sidebar chip is derived from what is present: the kind (human vs
 * agent), and the roles (user) or token kind + scope count (agent). Pure +
 * unit-tested here; `components/app-shell.tsx` renders the result (that file is
 * e2e-covered, like `routes/**`).
 */
import type { WhoamiSession } from "./session";

export interface PrincipalView {
  /** Discriminator — drives the avatar treatment (human = square, agent = notched). */
  readonly kind: "user" | "agent";
  /** Single-letter avatar monogram (whoami carries no name to initial). */
  readonly monogram: string;
  /** Primary label — the principal kind, the most identity we have without a name. */
  readonly label: string;
  /** Secondary detail — roles (user) or token kind + scope count (agent). */
  readonly detail: string;
}

/** Project a `WhoamiSession` into the sidebar principal chip's display model. */
export function describePrincipal(session: WhoamiSession): PrincipalView {
  if (session.kind === "agent") {
    const count = session.scopes.length;
    return {
      kind: "agent",
      monogram: "A",
      label: "Agent",
      detail: `${session.token_kind.toUpperCase()} · ${count} ${count === 1 ? "scope" : "scopes"}`,
    };
  }
  return {
    kind: "user",
    monogram: "U",
    label: "User",
    detail: session.roles.map((role) => role.toUpperCase()).join(" · ") || "no roles",
  };
}
