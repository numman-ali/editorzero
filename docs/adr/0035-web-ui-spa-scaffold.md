# ADR 0035 — Web UI SPA scaffold: app layout, dev-loop, router mode, and frontend supply-chain posture

**Status:** Accepted (2026-05-31)
**Date:** 2026-05-31
**Deciders:** Claude Opus 4.8 (scaffolding specifics, delegated per AGENTS.md); @numman (frontend supply-chain posture)

## Context

Deliverable #3 of the Web UI keystone scaffolds `apps/app` — the Vite + React SPA — and lands its first parity cell (sign-in + `doc.list × Web UI`). The "no feature code without an ADR" rule applies, so the scaffolding decisions must be recorded first.

ADRs 0027–0033 pin the architecture: a Vite + React SPA served as static assets by the Hono trunk (0027), TanStack Router in **library mode** + TanStack Query with `packages/api-client` as the *only* client seam (0028, raw `hc<AppType>` forbidden outside it), BlockNote for the Phase-1 editor (0031), `ssr: false`, and `serveStatic` as the production delivery mechanism. Two Opus sub-agents (an ADR-coverage sweep and a current-library-version pass, both 2026-05-31) confirmed those are settled but found **four scaffolding specifics no ADR decides**:

1. **App directory + workspace name** — `apps/app` appears in `docs/architecture/16-…md` and `packages/api-client/src/http-client.ts` by convention, but no ADR names it.
2. **Dev-loop topology** — Vite dev server proxying to the trunk vs. trunk-serves-built-assets is undecided.
3. **`serveStatic` root ↔ Vite `outDir`** — the production wiring point in `apps/server` is a future-work stub; no concrete path is fixed.
4. **Router mode** — "library mode" does not resolve file-based (Vite plugin codegen) vs. code-based routes.

Introducing the frontend dependency tree also forces a **supply-chain posture**. The library pass flagged — and direct verification against the GitHub Advisory Database confirmed — that the chosen router was hit by a critical npm compromise:

- **CVE-2026-45321 / GHSA-g7cv-rxg3-hmpx (CVSS 9.6), 2026-05-11.** 84 malicious versions across 42 `@tanstack/*` packages were published via GitHub Actions cache poisoning + OIDC-token theft (the first npm compromise to carry *valid SLSA provenance*). Payload `router_init.js` exfiltrates cloud/GitHub/SSH credentials and installs a daemon that `rm -rf ~/`'s the home directory when the GitHub token is revoked. The affected `@tanstack/react-router` versions were **1.169.5 / 1.169.8**, pulled from the registry within the hour; TanStack confirmed every currently-published version is clean as of 2026-05-12. ([GHSA-g7cv-rxg3-hmpx](https://github.com/advisories/GHSA-g7cv-rxg3-hmpx), [TanStack postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem)).

Pre-decision verification (read-only) confirmed this repo and machine are **uncompromised**: no `@tanstack/router*` family in `pnpm-lock.yaml` (only the confirmed-clean `@tanstack/store`), no affected versions anywhere, no persistence daemon (`com.user.gh-token-monitor.plist` / `gh-token-monitor.service` both absent), no payload artifacts in the repo or `~/.claude`. The router stays — it is ADR-0028-decided, current versions are clean, and switching away over a now-resolved incident would be an over-correction — but the incident makes a deliberate supply-chain posture mandatory rather than incidental.

## Options considered

### App directory + name
- **`apps/app` / `@editorzero/app`** — matches the existing `apps/cli` (`@editorzero/cli`) + `apps/server` (`@editorzero/server`) convention and the names already used in the architecture docs and `http-client.ts`. Zero surprise.
- `apps/web` / `apps/ui` — would contradict the convention already written down; the stale `apps/web/api-server` reference (pre-ADR-0029, now `packages/api-server`) is exactly the drift to avoid re-introducing.

### Dev-loop topology
- **Vite dev server + same-origin proxy to the trunk** — the browser talks only to Vite (`:5173`); Vite proxies the API/auth/MCP/collab prefixes to the trunk (`:3000`). Cookies stay first-party to the Vite origin, so ADR 0030's `SameSite=Lax` / no-CORS model holds *in dev too*. HMR works normally.
- Trunk serves built assets in dev (watch + rebuild) — loses HMR, slow inner loop, no benefit.
- Browser → Vite for assets but → trunk directly for API — cross-origin in dev, breaks the Lax/no-CORS assumption the whole auth design rests on. Rejected.

### Router mode
- **File-based via `@tanstack/router-plugin/vite`** (`tanstackRouter({ target: 'react', autoCodeSplitting: true })`) — the documented default; `autoCodeSplitting` directly delivers ADR 0028's "code-split per route"; routes in `src/routes`, generated tree `src/routeTree.gen.ts`.
- Code-based (hand-authored `createRoute` trees) — more boilerplate, manual code-splitting, diverges from the idiom and from 0028's intent.

### Supply-chain posture
Decided with @numman (he selected **pin + lockfile + cooldown** over pin-only and over the maximal CI-signature-gate option). See Decision.

## Decision

1. **`apps/app`**, workspace package `@editorzero/app`, `private: true` (never published).

2. **Dev loop = Vite dev server with a same-origin reverse proxy.** `vite.config.ts` `server.proxy` forwards the trunk-owned prefixes to `http://localhost:3000`: the five capability domains (`/infra`, `/docs`, `/collections`, `/workspaces`, `/audit`), plus `/auth` (Better Auth), `/mcp`, and `/collab` (`ws: true`). Everything else is the SPA. The proxy prefix list **is the API namespace** — derive it from the capability registry / route domains where practical so it cannot drift from the trunk. **Routing-namespace rule:** the SPA's client routes must avoid those reserved prefixes (the first slice uses `/` and `/login`); a client route at `/docs` would collide with the API and is forbidden. The production SPA-fallback (serve `index.html` for unclaimed GET paths) belongs to the ADR-0027 production WS/static attach pass, not this scaffold.

3. **Build output `apps/app/dist`** (Vite default `outDir`), consumed by the trunk's `serveStatic({ root: … })` in the production attach pass. The attach pass resolves the path relative to the server package; this ADR fixes the contract (`apps/app/dist` is the artifact), not the runtime path resolution.

4. **File-based routing** via `@tanstack/router-plugin/vite` with `autoCodeSplitting: true`. Plugin **before** `react()` in the plugins array (load-bearing per the plugin docs). `src/routeTree.gen.ts` is generated, not authored — gitignored.

5. **Frontend supply-chain posture (with @numman): pin + lockfile + cooldown.**
   - **Exact-pin every frontend dependency** (no `^`/`~`) — runtime and dev. The committed `pnpm-lock.yaml` is the exact record.
   - **pnpm release-age cooldown.** Set `minimumReleaseAge: 4320` (3 days, minutes) in `pnpm-workspace.yaml`, so a version yanked within the hour (the documented norm for these compromises) can never resolve on a future bump. `minimumReleaseAgeExclude` is the escape hatch for an urgent in-window security patch. **Requires pnpm ≥ 10.16.0** — the repo pins `pnpm@10.0.0`, so `packageManager` bumps to the current 10.x as a prerequisite (verified at implementation; integrity-checked by Corepack).
   - **Sequencing avoids a chicken-and-egg block:** the initial verified pins (e.g. `@tanstack/react-router@1.170.10`, published ~1 day ago) are resolved and captured in the lockfile *before* the cooldown is set; since subsequent installs replay the lockfile, the cooldown then governs only future version *changes* — which is exactly where the protection is wanted.

6. **Pinned version set** (verified against the npm registry + official docs, 2026-05-31; exact pins finalized in the lockfile):

   | Package | Pin | Note |
   |---|---|---|
   | `react`, `react-dom` | `19.2.6` | current stable line |
   | `@tanstack/react-router` | `1.170.10` | **post-incident clean** (affected: 1.169.5/1.169.8) |
   | `@tanstack/react-router-devtools` | `1.170.x` | align to the router release train |
   | `@tanstack/router-plugin` | `1.168.13` | Vite plugin (dev); `tanstackRouter` from `/vite` |
   | `@tanstack/react-query` | current 5.x | the one data idiom (ADR 0028) |
   | `@blocknote/core`, `@blocknote/react`, `@blocknote/mantine` | `0.51.3` | versioned in lockstep; React 19 supported (no React-18 cap) |
   | `@mantine/core`, `@mantine/hooks` | current 9.x | BlockNote view peer |
   | `vite` | `8.0.14` | Vite 8 (Rolldown); config-transparent for a plain SPA |
   | `@vitejs/plugin-react-swc` | current v4 | SWC Fast Refresh; no Babel (React Compiler not adopted) |
   | `@types/react`, `@types/react-dom` | `19.2.x` | — |
   | `typescript`, `vitest` | workspace catalog | `^5.7` / `^3` already pinned repo-wide |

   The two dev-tooling pins left as "current" (swc plugin patch, devtools patch) are confirmed against the registry at scaffold time and captured exactly in the lockfile.

7. **BlockNote client shape (Phase 1):** `useCreateBlockNote` from `@blocknote/react`, `BlockNoteView` from `@blocknote/mantine` (the view moved out of `@blocknote/react`); **both** CSS imports required (`@blocknote/core/fonts/inter.css` + `@blocknote/mantine/style.css`). `ssr: false` makes BlockNote's SSR caveat a non-issue. The doc body is the live Yjs CRDT over the collab WS (not Query state), per 0028.

## Consequences

- **Scaffolding is now unambiguous** — an agent (or @numman) building `apps/app` has the dir name, dev loop, build artifact, router mode, version set, and security posture fixed. The agentic-drift hazard the ADR-first rule targets is closed for this slice.
- **Dev preserves the production auth model.** Because the browser only ever sees the Vite origin, `SameSite=Lax` + no-CORS holds in dev exactly as in production — no dev-only CSRF/cookie special-casing, and the ADR 0030 WS auth path is exercisable through the proxy (`/collab`, `ws: true`).
- **A pnpm bump lands as a prerequisite.** `10.0.0 → current 10.x` is a same-major toolchain update (Corepack integrity-checked). Cheap, but it is a real first step before `pnpm install` in `apps/app`.
- **Future dependency bumps wait ~3 days.** The accepted cost of the cooldown: a genuinely urgent same-day security patch needs a temporary `minimumReleaseAgeExclude` entry. The protection — never resolving a fast-yanked malicious version — is judged worth it given a CVSS 9.6 just hit this exact ecosystem.
- **The URL namespace is now a shared contract.** SPA client routes and trunk API prefixes share one origin, so the reserved-prefix rule (#2) is a standing constraint the production SPA-fallback (ADR 0027 attach pass) must also honor.
- **`@better-auth/agent-auth` is *not* a real off-the-shelf package** (noted while surveying the auth stack; the comment in `packages/auth/src/create-auth.ts` and ADR 0010's plugin list imply otherwise). Correcting that and the agent-principal resolver design is the agent-auth slice's job, out of scope here — flagged so it is not lost.

## Revisit triggers

- **The SPA must move to a separate origin** (CDN-hosted, separate auth domain): the same-origin dev proxy and ADR 0030's Lax/no-CORS dividend both fall away — re-introduce CORS + `trustedOrigins` + `SameSite=None` in dev and prod. Downstream of ADR 0027's single-box trigger.
- **The cooldown blocks an urgent security upgrade too often**, or a transitive dep can't satisfy it: tune `minimumReleaseAge` / add `minimumReleaseAgeExclude` / reconsider `minimumReleaseAgeStrict`.
- **TanStack ships a hardened release line** (post-incident provenance/attestation guarantees) that makes the maximal CI-signature gate cheap: reconsider the rejected "add CI signature gate" option.
- **File-based routing's generated tree fights the monorepo** (plugin can't resolve `src/routes` from the package root): fall back to code-based routes for the affected subtree.

## Cross-references

- **Depends on / implements** ADR 0027 (SPA-as-static-assets, `serveStatic`, the production attach pass), ADR 0028 (TanStack Router library mode + the `packages/api-client` seam + one data idiom), ADR 0030 (same-origin Lax cookies — the dev proxy preserves them), ADR 0031 (BlockNote Phase-1 editor).
- **Informs** the ADR 0027 production WS/static attach pass (the SPA-fallback + `serveStatic` root resolution + the four deferred collab hardening blockers in ADR 0030).
- **Research:** Opus sub-agent ADR-coverage + library-version passes (2026-05-31); supply-chain verification against [GHSA-g7cv-rxg3-hmpx](https://github.com/advisories/GHSA-g7cv-rxg3-hmpx) + the [TanStack postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem).
