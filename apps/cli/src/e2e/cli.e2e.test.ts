/**
 * True end-to-end smoke — the `bun build --compile`-produced `ez`
 * binary hits a real HTTP server over TCP (ADR 0012, ADR 0021 §CLI).
 *
 * Motivation. Every other test that touches the CLI ↔ trunk boundary
 * runs in-process: `auth.integration.test.ts` and
 * `doc-list.integration.test.ts` bind `trunk.request` as the injected
 * `fetch` so the request never crosses a socket. Those prove Hono +
 * generator + dispatcher logic agrees, but they do not prove that
 * `bun build --compile` produces a working binary, that the binary
 * speaks the same HTTP the trunk listens for, that cookies serialize
 * through Node's real `http` stack, or that AXI stdout over a real
 * pipe is parseable. This test covers that gap — the production
 * artifact actually talks to the production trunk over a real port.
 *
 * Shape. `beforeAll` handles the expensive one-off setup:
 *   1. Compiles the CLI via `bun build --compile --outfile <tmp>/ez`.
 *   2. Builds a full `createApiApp({ auth, loadRoles, dispatcher })`
 *      against a `:memory:` SQLite driver with the `doc.create` and
 *      `doc.list` capabilities registered (enough to exercise write
 *      then read via the CLI without touching SQL directly).
 *   3. Boots the trunk on an ephemeral port via `@hono/node-server`.
 *   4. Signs up a test user through `/auth/sign-up/email` so the
 *      `workspace_members` bootstrap hook runs.
 *
 * `beforeEach` mints a fresh `HOME` tmp dir. Each test spawns the
 * compiled binary with `HOME` pointed at its own tmp dir so
 * `SessionCookieStore` (which writes `$HOME/.editorzero/credentials`)
 * starts empty for every test. Codex's review called this out — a
 * sequential test-to-test credential dependency would have made test
 * 1's failure silently contaminate test 2's read, so isolation is
 * per-test.
 *
 * Cases:
 *   a. Happy path — `ez auth login --password-stdin` → `ez doc create
 *      --title ...` → `ez doc list`. Asserts exit 0s, AXI stdout
 *      shape, and that the credential file lands at
 *      `$HOME/.editorzero/credentials`.
 *   b. Credential-less — `ez doc list` invoked with a freshly-minted
 *      (empty) HOME emits AXI `auth_expired` + exit 1 without
 *      touching the network. Inverse of (a); proves the no-creds
 *      short-circuit over a real subprocess stdout.
 *   c. Agent bearer (ADR 0044) — an owner mints an agent + read-only
 *      token via `ez agent create` / `ez agent token_mint`, then a
 *      process carrying ONLY `EDITORZERO_AGENT_TOKEN` (pristine HOME,
 *      no cookie) resolves `ez auth whoami` to the AGENT principal and
 *      runs `ez doc list`. Proves the env-var → `BearerTokenStore`
 *      selection in the compiled binary, which the unit lane cannot see
 *      (`index.ts` is coverage-excluded). The fixture registers the
 *      agent-lifecycle capabilities and wires `resolveAgentToken` so the
 *      mint routes exist and the bearer arm is live.
 *
 * Why this is the right gap to close. Phase 3 surface-adapter work
 * (ADR 0021) needs verification that the shipping artifact actually
 * works against the real HTTP path — not just against an in-process
 * binding. Adding more surfaces (MCP, Web UI) before this check
 * would layer surfaces on an unverified foundation. The compile step
 * is the same `bun build --compile` ADR 0012 names as the deploy
 * artifact, so success here confirms both the build recipe and the
 * runtime recipe.
 *
 * Excluded from coverage collection (see `vitest.e2e.config.ts` —
 * coverage is off for e2e because the compiled-binary subprocess's
 * execution isn't visible to the test-process's v8 counters).
 *
 * Runs in pre-push only (lefthook `e2e` lane), not pre-commit — the
 * bun-compile step is ~5–10s which would noisily slow the fast lane.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createApiApp, createApiDispatcher } from "@editorzero/api-server";
import { createAuth, runAuthMigrations } from "@editorzero/auth";
import {
  agentCreate,
  agentTokenMint,
  createRegistry,
  docCreate,
  docList,
  registerCapability,
} from "@editorzero/capabilities";
import {
  createDocUpdatesReader,
  createDocUpdatesWriter,
  createLoadRoles,
  createResolveAgentToken,
  createSqliteDriver,
  SQLITE_FULL_DDL,
  type SqliteDriver,
} from "@editorzero/db";
import { HocuspocusSync } from "@editorzero/sync";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = resolve(CLI_ROOT, "src", "index.ts");

const TEST_EMAIL = "e2e-cli@example.com";
const TEST_PASSWORD = "correct-horse-battery-staple";

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function compileCli(outfile: string): Promise<void> {
  // `bun build --compile` produces a single-file executable. Re-built
  // per test run (not cached) so a source change that breaks the
  // compile surface fails this suite, which is precisely the signal
  // this test exists to provide.
  const result = await runProcess("bun", ["build", "--compile", "--outfile", outfile, CLI_ENTRY]);
  if (result.exitCode !== 0) {
    throw new Error(`bun build --compile failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
}

async function runProcess(
  bin: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly stdin?: string } = {},
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((accept, reject) => {
    const child = spawn(bin, [...args], {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      accept({ exitCode: code ?? -1, stdout, stderr });
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

/**
 * A spawn env rooted at `home`, with `EDITORZERO_AGENT_TOKEN` controlled
 * explicitly: stripped from the ambient environment unless `agentToken`
 * is passed. Without this, a developer who exports the var in their shell
 * would silently flip every cookie-path test into bearer mode (ADR 0044)
 * and break it — the suite must own that switch, not inherit it.
 */
function makeBinEnv(home: string, agentToken?: string): NodeJS.ProcessEnv {
  const { EDITORZERO_AGENT_TOKEN: _ambient, ...rest } = process.env;
  const env: NodeJS.ProcessEnv = { ...rest, HOME: home };
  if (agentToken !== undefined) env["EDITORZERO_AGENT_TOKEN"] = agentToken;
  return env;
}

describe("ez CLI — compiled-binary round-trip against a real HTTP trunk", () => {
  // `binPath` + `server` + `driver` are `beforeAll` state — compiling
  // the binary and booting the server are the expensive steps and we
  // do them once. `homeDir` is per-test (`beforeEach`) so each test
  // owns its credential file independently: test 2 starts with a
  // pristine (logged-out) home rather than inheriting test 1's
  // cookie. Codex review drove this split — sequential dependence
  // between tests would have made a failure in test 1 mis-report
  // test 2.
  let binPath: string;
  let binRoot: string;
  let homeDir: string;
  let baseUrl: string;
  let driver: SqliteDriver;
  let sync: HocuspocusSync;
  let server: ReturnType<typeof serve>;

  beforeAll(async () => {
    // Compile the binary once — re-compiling in each test would add
    // ~10s per case for zero additional signal (the build surface
    // either regresses or it doesn't; running the compile twice
    // doesn't tell us more). Kept in its own tmp dir so afterAll's
    // cleanup doesn't race with any test's per-test tmp dir.
    binRoot = mkdtempSync(join(tmpdir(), "ez-cli-e2e-bin-"));
    binPath = join(binRoot, "ez");
    await compileCli(binPath);

    driver = createSqliteDriver({ path: ":memory:" });
    driver.exec(SQLITE_FULL_DDL);

    const registry = createRegistry([
      registerCapability(docCreate),
      registerCapability(docList),
      // Agent lifecycle — enough to mint a credential via the binary
      // (`ez agent create` → `ez agent token_mint`) so the bearer case
      // below proves the whole loop through the shipping artifact.
      registerCapability(agentCreate),
      registerCapability(agentTokenMint),
    ]);
    // `doc.create` seeds an empty paragraph via `ctx.transact` — the
    // write-path binding needs a live `HocuspocusSync`, otherwise the
    // dispatcher throws a descriptive "sync not wired" error (see
    // `createApiDispatcher.ts` § sync is optional). Production
    // composition always passes one; the e2e fixture mirrors that
    // shape so the create → list round-trip exercises the real
    // `doc_updates` + audit-in-tx path (ADR 0018).
    sync = new HocuspocusSync({
      docUpdatesWriter: createDocUpdatesWriter(),
      docUpdatesReader: createDocUpdatesReader(),
      systemDb: driver.system(),
    });
    const dispatcher = createApiDispatcher({ driver, registry, sync });
    // `baseURL` here is the string Better Auth uses for absolute-URL
    // generation (email links, redirects); the actual listen port is
    // chosen by the kernel below. Keep them in sync by overwriting
    // `baseURL` after the server binds, but BA's cookie-domain check
    // only cares about the origin, so "localhost" alone is enough
    // for same-origin CLI→server calls.
    const loopbackOrigin = "http://localhost";
    const auth = createAuth({
      driver,
      baseURL: loopbackOrigin,
      secret: "test-secret-do-not-use-in-production-at-all",
      trustedOrigins: [loopbackOrigin],
      registrationMode: "open",
    });
    await runAuthMigrations(auth);
    const loadRoles = createLoadRoles(driver);
    // The bearer arm (ADR 0044 Decision 4) — without it `createApiApp`
    // leaves the principal resolver cookie-only and an agent token 401s.
    const resolveAgentToken = createResolveAgentToken(driver);
    const trunk = createApiApp({ auth, loadRoles, dispatcher, resolveAgentToken });

    // `serve(..., listener)` calls the listener with `AddressInfo`
    // once the socket binds; port 0 picks any free port. The same
    // server ref is closed in `afterAll`.
    const { port } = await new Promise<AddressInfo>((accept) => {
      server = serve({ fetch: trunk.fetch, port: 0 }, (info) => accept(info));
    });
    baseUrl = `http://localhost:${port}`;

    // Sign up the test user against the running trunk — we use real
    // fetch so the request crosses the socket too. This runs the
    // Better Auth signup hook which seeds the `workspace_members`
    // row (ADR 0024) so the principal resolver returns a role.
    const signUpRes = await fetch(`${baseUrl}/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: "e2e user",
      }),
    });
    if (signUpRes.status !== 200) {
      throw new Error(`sign-up failed with status ${signUpRes.status}`);
    }
  }, 60_000);

  afterAll(async () => {
    await promisify(server.close.bind(server))();
    await sync.close();
    await driver.close();
    rmSync(binRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Fresh per-test credential-file root. Each test sets HOME to
    // this dir when spawning the binary, so `SessionCookieStore`
    // (which writes `$HOME/.editorzero/credentials`) starts empty
    // for every test.
    homeDir = mkdtempSync(join(tmpdir(), "ez-cli-e2e-home-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("logs in, creates a doc, and lists it — over real TCP", async () => {
    const binEnv = makeBinEnv(homeDir);

    // 1. Login — the binary POSTs to /auth/sign-in/email via its real
    //    global fetch, parses Set-Cookie, and persists to
    //    $HOME/.editorzero/credentials.
    const login = await runProcess(
      binPath,
      ["auth", "login", "--email", TEST_EMAIL, "--password-stdin", "--base-url", baseUrl],
      { env: binEnv, stdin: TEST_PASSWORD },
    );
    expect(login.exitCode, login.stderr || login.stdout).toBe(0);
    expect(JSON.parse(login.stdout)).toEqual({ ok: true, email: TEST_EMAIL });

    const credsPath = join(homeDir, ".editorzero", "credentials");
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as { cookie: string };
    expect(creds.cookie).toContain("session_token");

    // 2. Create a doc — exercises POST /docs/create through the
    //    generator's HTTP binding; the handler runs under the
    //    dispatcher's write-path tx (ctx.transact seeds blocks,
    //    doc_updates row lands, audit_events row lands).
    const create = await runProcess(
      binPath,
      ["doc", "create", "--title", "E2E created", "--base-url", baseUrl],
      { env: binEnv },
    );
    expect(create.exitCode, create.stderr || create.stdout).toBe(0);
    const created = JSON.parse(create.stdout) as { doc_id: string; title: string };
    expect(created.title).toBe("E2E created");
    expect(created.doc_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);

    // 3. List docs — exercises GET /docs/list; confirms the doc
    //    created by step 2 is visible through the same workspace-
    //    scoping plugin the integration tests cover in-process.
    const list = await runProcess(binPath, ["doc", "list", "--base-url", baseUrl], { env: binEnv });
    expect(list.exitCode, list.stderr || list.stdout).toBe(0);
    const listBody = JSON.parse(list.stdout) as {
      docs: readonly { id: string; title: string }[];
    };
    expect(listBody.docs).toHaveLength(1);
    expect(listBody.docs[0]?.id).toBe(created.doc_id);
    expect(listBody.docs[0]?.title).toBe("E2E created");
  }, 30_000);

  it("emits auth_expired with exit 1 when invoked with no credential file", async () => {
    // Self-contained: the fresh `homeDir` from `beforeEach` has no
    // credential file, so `SessionCookieStore.read()` returns null
    // and `runCapability` short-circuits to AXI `auth_expired`
    // before any fetch runs. Proves the no-creds AXI path over a
    // real subprocess stdout — the inverse of test 1's happy path.
    const binEnv = makeBinEnv(homeDir);
    const result = await runProcess(binPath, ["doc", "list", "--base-url", baseUrl], {
      env: binEnv,
    });
    expect(result.exitCode).toBe(1);
    const body = JSON.parse(result.stdout) as { error: { code: string } };
    expect(body.error.code).toBe("auth_expired");
  });

  it("authenticates as the AGENT from EDITORZERO_AGENT_TOKEN alone — no cookie (ADR 0044 inc 4)", async () => {
    // The headline dogfood of ADR 0044's bearer arm, end-to-end through
    // the SHIPPING binary: an owner logs in and mints an agent + a
    // read-only token via `ez agent …`, then a process holding ONLY that
    // token — a pristine HOME, no credential file — drives the CLI and
    // resolves to the AGENT principal. Proves the env-var → BearerTokenStore
    // selection in the compiled `index.ts` wiring (coverage-excluded, so
    // unprovable by the unit lane) and that the Bearer header survives the
    // bun-compiled runtime + a real socket.
    const ownerEnv = makeBinEnv(homeDir);

    // 1. Owner logs in (cookie → this test's HOME) so it can mint.
    const login = await runProcess(
      binPath,
      ["auth", "login", "--email", TEST_EMAIL, "--password-stdin", "--base-url", baseUrl],
      { env: ownerEnv, stdin: TEST_PASSWORD },
    );
    expect(login.exitCode, login.stderr || login.stdout).toBe(0);

    // 2. Create an agent via the registry-derived `ez agent create`.
    const create = await runProcess(
      binPath,
      ["agent", "create", "--name", "E2E bearer agent", "--base-url", baseUrl],
      { env: ownerEnv },
    );
    expect(create.exitCode, create.stderr || create.stdout).toBe(0);
    const agent = JSON.parse(create.stdout) as { agent_id: string };
    expect(agent.agent_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}/u);

    // 3. Mint a read-only token via `ez agent token_mint` — show-once secret.
    const mint = await runProcess(
      binPath,
      [
        "agent",
        "token_mint",
        "--agent_id",
        agent.agent_id,
        "--tier",
        "read-only",
        "--base-url",
        baseUrl,
      ],
      { env: ownerEnv },
    );
    expect(mint.exitCode, mint.stderr || mint.stdout).toBe(0);
    const minted = JSON.parse(mint.stdout) as { token: string };
    expect(minted.token.startsWith("ez_agent_")).toBe(true);

    // 4. A pristine HOME (no credential file) + the token in the env. The
    //    token ALONE must authenticate: nothing to fall back to, and the
    //    bearer store never reads HOME.
    const bearerHome = mkdtempSync(join(tmpdir(), "ez-cli-e2e-bearer-"));
    try {
      const bearerEnv = makeBinEnv(bearerHome, minted.token);

      // 4a. `ez auth whoami` resolves to the AGENT (api-key), not a user —
      //     also exercises the whoami handler's bearer-awareness.
      const whoami = await runProcess(binPath, ["auth", "whoami", "--base-url", baseUrl], {
        env: bearerEnv,
      });
      expect(whoami.exitCode, whoami.stderr || whoami.stdout).toBe(0);
      const principal = JSON.parse(whoami.stdout) as {
        kind: string;
        id: string;
        token_kind: string;
        scopes: readonly string[];
      };
      expect(principal.kind).toBe("agent");
      expect(principal.id).toBe(agent.agent_id);
      expect(principal.token_kind).toBe("api-key");
      expect(principal.scopes).toContain("doc:read");

      // 4b. A real capability command authenticates under the same token:
      //     `ez doc list` succeeds on the read-only scope set.
      const list = await runProcess(binPath, ["doc", "list", "--base-url", baseUrl], {
        env: bearerEnv,
      });
      expect(list.exitCode, list.stderr || list.stdout).toBe(0);
      const listBody = JSON.parse(list.stdout) as { docs: readonly unknown[] };
      expect(Array.isArray(listBody.docs)).toBe(true);
    } finally {
      rmSync(bearerHome, { recursive: true, force: true });
    }
  }, 30_000);
});
