import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: agent.list
 * proves-capability-cell: agent.get
 * proves-capability-cell: agent.create
 * proves-capability-cell: agent.update
 * proves-capability-cell: agent.revoke
 * proves-capability-cell: agent.token_list
 * proves-capability-cell: agent.token_mint
 * proves-capability-cell: agent.token_revoke
 *
 * The eight `agent.*` × Web UI parity cells (invariant 4 + invariant 8,
 * ADR 0044 Decision 7) — the Agents screen end-to-end against the real
 * stack. The marker lines above are load-bearing: `packages/contract-tests`
 * scans the e2e specs for `proves-capability-cell:` and fails the build if
 * a capability declares `"ui"` without a spec carrying its marker.
 *
 * FILENAME — `credentials`, not `agents`: the suite runs files in
 * alphabetical order on one worker, and `auth.spec.ts` MUST run first (it
 * performs the one-time genesis sign-up that closes the registration gate;
 * every later spec signs IN). `agents.spec.ts` would sort BEFORE `auth`
 * and run with no founder yet. `credentials` sorts after `auth` and names
 * what the screen is FOR — agent bearer credentials (ADR 0044's "agent
 * credential substrate") — the same evocative-name latitude `trail.spec.ts`
 * takes for the audit screen.
 *
 * The proof walks the agent lifecycle on a single agent (serial, shared
 * server DB): an empty roster reads server truth, create → land on detail,
 * rename, mint a token (with the show-once reveal), revoke that token, then
 * revoke the agent — each step asserted in the browser, no fixtures, no
 * route mocking. The screen lives at the SINGULAR `/agent` (`/agents` is the
 * trunk API domain + a reserved prefix).
 */
test.describe.configure({ mode: "serial" });

/** API sign-in via the page's own request context (the spaces.spec pattern). */
async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

/** Open the (only) agent's detail screen via its roster card — name-independent. */
async function openOnlyAgent(page: Page): Promise<void> {
  await page.goto("/agent");
  await page.locator(".sp .nm a").first().click();
  await expect(page).toHaveURL(/\/agent\/[0-9a-f-]+$/);
}

test("the roster reads server state — empty until this spec creates an agent", async ({ page }) => {
  await signIn(page);
  await page.goto("/agent");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  // Nothing seeds agents (unlike the signup-seeded Personal space), so a
  // clean install shows the empty state — the screen renders SERVER truth.
  await expect(page.locator(".sp")).toHaveCount(0);
  await expect(page.getByText("No agents yet.")).toBeVisible();
  await expectNoAxeViolations(page);
});

test("create lands on the agent's detail screen, shown Active", async ({ page }) => {
  await signIn(page);
  await page.goto("/agent");
  // The agent.create cell: the panel-header morph form (name only).
  await page.getByRole("button", { name: "+ New agent" }).click();
  await page.getByLabel("Agent name").fill("Search Indexer");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // create → detail (the agent.get cell): header carries the name + the
  // live lifecycle chip.
  await expect(page).toHaveURL(/\/agent\/[0-9a-f-]+$/);
  await expect(page.locator("#agent-heading")).toHaveText("Search Indexer");
  await expect(page.locator('[aria-labelledby="agent-heading"] .status-tag')).toHaveText("Active");
  // The credential panel is present and empty for a fresh agent.
  await expect(page.getByText("No tokens minted yet.")).toBeVisible();
  await expectNoAxeViolations(page);

  // The agent.list cell: it now renders in the roster.
  await page.goto("/agent");
  await expect(page.locator(".sp .nm")).toHaveText(["Search Indexer"]);
  await expect(page.locator(".sp .status-tag")).toHaveText(["Active"]);
});

test("the detail screen renames the agent (agent.update)", async ({ page }) => {
  await signIn(page);
  await openOnlyAgent(page);
  await page.getByRole("button", { name: "Edit agent" }).click();
  await page.getByLabel("Agent name").fill("Search Reindexer");
  await page.getByRole("button", { name: "Save" }).click();
  // The header re-renders from the fresh agent.get row.
  await expect(page.locator("#agent-heading")).toHaveText("Search Reindexer");
});

test("minting a token reveals the secret once, then lists the token", async ({ page }) => {
  await signIn(page);
  await openOnlyAgent(page);
  // The agent.token_mint cell: pick a named tier and mint.
  await page.getByRole("button", { name: "+ Mint token" }).click();
  await page.getByLabel("Token tier").selectOption("read-only");
  await page.getByRole("button", { name: "Mint", exact: true }).click();
  // The show-once reveal: the plaintext bearer secret + the one-time
  // warning. This is the user's only chance to copy it.
  const reveal = page.locator(".token-reveal");
  await expect(reveal.locator(".token-reveal-value")).toHaveText(/^ez_agent_/);
  await expect(reveal.getByRole("alert")).toContainText("only time");
  await expectNoAxeViolations(page);
  await reveal.getByRole("button", { name: "Done" }).click();
  // The agent.token_list cell: the dismissed token now lists, Active, at
  // the minted tier.
  const rows = page.locator(".tt tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("read-only");
  await expect(rows.first().locator(".status-tag")).toHaveText("Active");
});

test("revoking the token flips it to Revoked in place (agent.token_revoke)", async ({ page }) => {
  await signIn(page);
  await openOnlyAgent(page);
  const table = page.locator("table.tt");
  await table.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(page.locator(".tt tbody tr .status-tag")).toHaveText("Revoked");
});

test("revoking the agent returns to the roster, shown Revoked (agent.revoke)", async ({ page }) => {
  await signIn(page);
  await openOnlyAgent(page);
  // The token is already revoked (prior test), so its in-row Revoke button
  // is gone — the only "Revoke" left is the agent's own.
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Revoke agent" }).click();
  // Terminal-but-visible: the agent stays in the roster, now Revoked.
  await expect(page).toHaveURL(/\/agent$/);
  await expect(page.locator(".sp .nm")).toHaveText(["Search Reindexer"]);
  await expect(page.locator(".sp .status-tag")).toHaveText(["Revoked"]);
});
