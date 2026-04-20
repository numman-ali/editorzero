# ADR 0025 — CLI auth bootstrap + credential-store seam

**Status:** Proposed
**Date:** 2026-04-20
**Deciders:** @numman

## Context

ADR 0021 pins the CLI as a pure HTTP consumer of the Hono trunk: `hc<AppType>(baseUrl, { headers: { Authorization } })` over real HTTP, same middleware chain as every other surface. ADR 0016 pins the `Principal` shape and enumerates the credential sources Better Auth produces (session cookie, human PAT, agent API-key, agent-auth JWT, MCP OAuth bearer). ADR 0010 names the BA plugin spine (`api-key`, `agent-auth`, `oauth-provider`).

What none of those ADRs pin:

- How the CLI **bootstraps** a credential in the first place (device flow? paste-PAT? email+password?).
- Where the credential **lives** on disk and how command handlers consume it without each one hand-rolling the read.
- How the CLI **orients itself** inside editorzero's principal model. BA's `/auth/get-session` returns BA session/user state, not the `Principal` shape the dispatcher/gate enforces (`kind`, `workspace_id`, `roles`, agent-vs-user).
- How AXI's "no interactive prompts" commitment interacts with a TTY-mode login affordance.

The CLI slice (P3.7) cannot proceed without settling these. This ADR settles them for the first slice under an explicit fence: the chosen bootstrap is **transitional**, and the store seam keeps device-flow / PAT / agent-token follow-ons local swaps rather than command-tree rewrites.

## Options considered

### A. Device authorization flow (OAuth 2.1 RFC 8628)

CLI hits `/auth/device/authorize`, prints `user_code` + `verification_uri` to stdout (plus `$XDG_RUNTIME_DIR/editorzero/device.json` per ADR 0021:70), polls `/auth/device/token` until the user completes consent in a browser. Credential is an OAuth access token, refreshable via a refresh token.

**Pros.** Canonical OAuth flow for CLIs authenticating a human against a remote service. Delegated consent is auditable. Refresh tokens rotate cleanly. BA ships the grant via `@better-auth/oauth-provider`.

**Cons.** **Requires a verification page** — an authenticated Web UI approve/deny surface. Web UI does not exist yet; without it the CLI has nowhere to send the user. This is a prerequisite, not a parallel track. Separately: the device-flow mechanics (endpoint spec, polling interval, code format, consent-page URL, refresh semantics) are unpinned and deserve their own ADR.

### B. Paste-PAT issued via admin UX

User generates a long-lived PAT via an admin surface, pastes into `ez auth login --token <...>`. Credential is a bearer API-key (BA `@better-auth/api-key` plugin, `principal.kind = "user"`).

**Pros.** Simplest credential semantics — single opaque bearer string, no refresh, resolves through the same middleware as every other surface. Aligns with ADR 0016's "Human PAT" row.

**Cons.** **No PAT-issuance UX exists yet** — no admin surface, no `ez admin token create` back-channel, no way to mint a first PAT without direct DB access or a pre-existing session against BA's API-key endpoint. The "get your first PAT" chicken-and-egg defers identically to option A's Web UI gap. PATs as a *first* bootstrap also normalize a weaker on-disk posture than device flow is designed to offer.

### C. Email+password → stored session cookie — CHOSEN (bounded bootstrap)

CLI's `ez auth login` prompts for email+password (TTY mode) or reads from `--password-stdin` (agent mode / CI), POSTs to the existing `/auth/sign-in/email` route on the Hono trunk, stores the resulting session cookie in `~/.editorzero/credentials` (0600 perms), and resends it on every subsequent `hc<AppType>` call as `Cookie: <session-token>`. `ez auth logout` POSTs to `/auth/sign-out` and clears the credential file. `ez auth whoami` calls a new `/infra/whoami` route that wraps `c.get("principal")` and returns editorzero's `Principal` shape.

**Pros.** **Works against the stack we have today.** `/auth/sign-in/email` + `/auth/sign-out` are live (verified in `packages/auth/src/create-auth.integration.test.ts` + `packages/api-server/src/composition/auth-chain.integration.test.ts`); session-cookie principal resolution is live post-ADR 0024. Zero new server-side work aside from `/infra/whoami`. Bounded by the store seam — when device flow / PATs land, the command tree doesn't change; only a new `CredentialStore` implementation plugs in.

**Cons.** Session cookies are not the canonical CLI credential model. BA sessions are time-limited; expiry manifests as 401s requiring re-login. No refresh mechanism — the CLI cannot rotate silently. None of this matters for a bounded transitional bootstrap; it would matter if this were the commitment.

### D. Agent-token-first

CLI's first bootstrap is an agent token (`@better-auth/api-key` with `principal.kind = "agent"`) — the CLI authenticates as an agent from the start.

**Pros.** Aligns with the "editorzero is an agent-native CLI" framing.

**Cons.** Confuses the principal model. `ez auth login` for a human should produce a `UserPrincipal`, not an `AgentPrincipal`. Audit attribution is wrong. Agent-mode CLI invocation (agent harness running `ez doc list`) is a separate axis from human bootstrap — agents get their own token when created via `agent.create`, not when a human logs in. This option conflates two concerns.

## Decision

**Adopt option C for the first slice, as a bounded transitional bootstrap.**

### Load-bearing commitments

1. **`AuthCredentialStore` seam** owns credential IO:

   ```ts
   interface AuthCredentialStore {
     read(): Promise<CredentialHeaders | null>;
     write(headers: CredentialHeaders): Promise<void>;
     clear(): Promise<void>;
   }
   type CredentialHeaders = Readonly<Record<string, string>>;
   ```

   `SessionCookieStore` is the slice-1 implementation (persists `{ cookie: "<session-token>" }`). Future `BearerTokenStore` / `OAuthTokenStore` plug in without touching command handlers or the `createHttpClient` wiring in `packages/api-client`.

2. **`/infra/whoami` is editorzero's canonical principal-orientation route.** Added to the Hono trunk alongside `/infra/health`. Runs through the same auth/principal middleware as every capability route; returns the resolved `Principal` (`kind`, `id`, `workspace_id`, `roles`, `session_id` / `token_id`, `token_kind` for agents). `ez auth whoami` calls this route — **not** BA's `/auth/get-session`, which would return BA's user/session shape and diverge from what the dispatcher/gate enforces. This closes the "CLI and dispatcher see the same truth" gap Codex flagged during peer review (see "Peer-review trail" below).

3. **`ez auth login` has dual-mode input.** TTY → interactive password prompt (clig.dev); non-TTY → `--password-stdin` required, otherwise fail fast with an AXI-shaped stdout error envelope naming the flag. AXI commitment "no interactive prompts" applies to agent mode only. Standard Unix idiom (see `podman login --password-stdin`, `docker login --password-stdin`).

4. **Credential file is `~/.editorzero/credentials`, mode 0600.** Single file, single credential; multi-profile support (`--profile <name>`) lands in a follow-on slice when demand is proven.

5. **Session expiry is fail-loud.** On 401 from any command, the CLI surfaces an AXI-shaped error envelope (stdout in agent mode) with `code: "auth_expired"` and `help: "Run 'ez auth login' to re-authenticate."`. No silent refresh — the transitional credential does not carry a refresh token.

6. **Transitional posture is ADR-visible.** `apps/cli/src/auth/session-cookie-store.ts` carries a top-of-file comment pointing here. When a follow-on ships (device flow / PAT / agent-auth), this ADR gets an amendment or supersession; the store seam absorbs the change.

### What this ADR does **not** commit

- **Device-flow mechanics** — endpoint spec, polling interval, code format, consent-page URL, refresh semantics. Deferred to a standalone ADR that lands with the Web UI authenticated approve/deny surface.
- **PAT issuance UX** — `ez admin token create` or a web-UI admin page. Deferred to the admin-surface slice.
- **Agent-token bootstrap for the CLI** — the CLI doesn't issue agent tokens; agents *receive* a token when created via `agent.create`. Agent-mode invocations load whatever credential the agent was created with (PAT or agent-auth JWT) via the same `AuthCredentialStore` seam.
- **Session-hook self-install** — the Claude Code / Codex `SessionStart` hook installation ADR 0021:72 names as an AXI commitment. Deferred to its own slice with the fences Codex flagged: compiled-binary-only (`process.execPath` in dev is Bun, not the shipped binary), skip-on-CI, honour `EDITORZERO_SKIP_HOOK_INSTALL=1`, silent self-heal on path relocation.
- **Output-format eval harness** (ADR 0021 Decision §6). Interim JSON satisfies AXI per ADR 0021:77.
- **Multi-profile / multi-tenant-endpoint CLI state.** Single-credential for slice 1.

## Consequences

- **First CLI slice is unblocked** without Web UI, without admin surface, without BA's device-flow plugin scope. Only routes required are already-live `/auth/sign-in/email` + `/auth/sign-out` plus one new `/infra/whoami`.
- **Command tree is stable across credential-model changes.** Adding device flow, PAT paste, or agent-auth bootstrap changes the `AuthCredentialStore` implementation and the `ez auth login` input parsing only. The command tree, dispatcher middleware, and `hc<AppType>` consumer pattern — unchanged.
- **`whoami` ↔ `Principal` symmetry** is enforced from slice 1: if the dispatcher/gate change how they derive `Principal.roles`, `whoami` reflects it automatically. Single route calling `c.get("principal")`. Same load-bearing principle as ADR 0024's "the resolver is the one source of role truth."
- **Session-cookie fragility surfaces early.** Users hit 401s on session expiry before device flow / PAT lands. Error message directs them to `ez auth login`. Accepted DX friction for the transitional slice; doubles as real-world validation that the store seam is worth its weight.
- **AXI "no interactive prompts" rule is honoured without breaking TTY UX** via `--password-stdin`.
- **ADR 0021's `/api/v1/*` mount prefix is not yet in place.** The current trunk serves `/auth/*`, `/infra/*`, `/docs/*` directly. This ADR follows the current mount shape; when `/api/v1/*` versioning lands, `/infra/whoami` moves with the rest — no ADR change.

## Revisit triggers

- **Web UI ships an authenticated device-flow approve/deny page** → device flow becomes viable; write the device-flow-mechanics ADR, implement `DeviceFlowCredentialStore`, add `ez auth login --device`. `SessionCookieStore` remains as a fallback for deployments without Web UI.
- **Admin surface ships PAT issuance UX** (web or CLI-side `ez admin token create`) → implement `BearerTokenStore`, add `ez auth login --token <token>`. `SessionCookieStore` may be deprecated once PAT bootstrap is the default.
- **Agent-auth delegated-token issuance is wired for CLI agent-mode** → implement `AgentAuthTokenStore`, add `ez auth login --agent-token <...>` or similar. Orthogonal to human bootstrap.
- **Session expiry friction proves unacceptable** (telemetry shows >N% of invocations 401 before device flow / PAT land) → add `ez auth refresh` or bake silent re-login into the CLI. Until then the fail-loud posture stands.
- **AXI spec changes the "no interactive prompts" rule** → re-evaluate the `--password-stdin` dual-mode pattern. Current commitment is to AXI as of 2026-04-20.

## Cross-references

- **Refines ADR 0021 (surface transport).** Names the concrete bootstrap credential for the CLI, adds `/infra/whoami` to the trunk, commits the `AuthCredentialStore` seam in `apps/cli/src/auth/`. ADR 0021:62's "bearer / API-key auth" is accurate for the long-term posture — this ADR's session-cookie is the transitional bootstrap that lets slice 1 ship before bearer-credential issuance UX exists.
- **Refines ADR 0016 (principal model).** No new credential sources; adds an orientation route (`/infra/whoami`) that reads the `Principal` shape ADR 0016 pins.
- **Refines ADR 0010 (Better Auth spine).** Uses `/auth/sign-in/email` + `/auth/sign-out` (BA core, already in use for Web UI flow per ADR 0024's integration tests). No new BA plugin scope.
- **Binds ADR 0024 (workspace membership).** `Principal.roles` returned by `/infra/whoami` is sourced from `workspace_members` via the `loadRoles` resolver ADR 0024 introduces.
- **Binds AGENTS.md invariant 4 + 5.** `ez auth whoami` uses the same middleware chain as capability routes; the CLI consumes auth through the trunk, not via a bypass.

## Sources

- BA email/password routes: https://www.better-auth.com/docs/authentication/email-password
- AXI — Agent eXperience Interface: https://github.com/kunchenguid/axi (see ADR 0021:65–72 for the full reproduction)
- OAuth 2.1 Device Authorization Grant (RFC 8628): https://datatracker.ietf.org/doc/html/rfc8628
- `podman login --password-stdin` (prior art for the AXI-compliant pattern): https://docs.podman.io/en/latest/markdown/podman-login.1.html

## Peer-review trail

Codex round (2026-04-20, surface:126). Drove three substantive changes before this ADR accepted:

1. **Add `/infra/whoami` or drop `whoami` from slice 1.** BA's `/auth/get-session` returns BA session/user state, not editorzero's `Principal`; a `whoami` calling it would silently disagree with the dispatcher/gate. `/infra/whoami` landed as a first-class route on the trunk. **Accepted** (load-bearing commitment #2).
2. **Fence the session-cookie bootstrap.** Store-seam, `--password-stdin`, transitional-posture fences. **Accepted** (load-bearing commitments #1, #3, #6).
3. **Scope hook self-install tightly when it lands.** Compiled-binary-only, skip-on-CI, env-var opt-out. **Accepted**, noted under "What this ADR does not commit"; the full fences land with the hook-install slice ADR.

Non-ADR-level (implementation) calls Codex also pushed that this slice will honour:

- **Generator emits even at N=1.** First capability command goes through the registry-driven generator, not a hand-wired `defineCommand`. Auth subtree is the exception (not registry-derived — hand-written is correct there).
- **CLI dep graph stays thin.** `apps/cli` imports only `citty` + `@editorzero/api-client` + output/config helpers. No leakage from `@editorzero/auth` / `@editorzero/db` / `better-sqlite3` — accidental imports from server-side packages are the real `bun build --compile` land-mine, not `citty` itself.
