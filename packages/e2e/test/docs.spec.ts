import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: doc.list
 *
 * The `doc.list × Web UI` parity cell (invariant 4, ADR 0033 §3 / 0040
 * H11). The marker line above is load-bearing: `packages/contract-tests`
 * scans the e2e specs for `proves-capability-cell:` and fails the build if
 * a capability declares `"ui"` without a spec carrying its marker — this
 * file is what lets `doc.list` declare the surface.
 *
 * The proof is end-to-end against real server data: the suite signs in as
 * the genesis founder (created by `auth.spec.ts` — files run
 * alphabetically, single worker), asserts the EMPTY state first (fresh
 * SQLite per run, and nothing before this file creates docs), then creates
 * docs over the same HTTP API the other surfaces use and asserts the
 * screen renders them. No fixtures, no route mocking — a hardcoded list
 * would fail here.
 */
test.describe.configure({ mode: "serial" });

/**
 * API sign-in via the page's own request context: the response set-cookie
 * lands in the browser context's jar, so the subsequent `page.goto` is an
 * authenticated visit. Cookieless POST → Better Auth's origin check does
 * not fire (CLI-class traffic; origin.spec.ts proves the cookie-bearing
 * rejection arm).
 */
async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

test("an empty Space renders the docs panel with its empty state", async ({ page }) => {
  await signIn(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
  await expect(page.getByText("No docs in this Space yet.")).toBeVisible();
  await expectNoAxeViolations(page);
});

test("docs created over the API render in the list with slug, visibility, and date", async ({
  page,
}) => {
  await signIn(page);
  // Create through the same capability surface (POST /docs/create) the
  // API/CLI/MCP cells use — the UI cell must show *server* state.
  for (const title of ["Launch checklist", "Meridian field notes"]) {
    const res = await page.request.post("/docs/create", { data: { title } });
    expect(res.ok()).toBe(true);
  }

  await page.goto("/");
  const table = page.getByRole("table");
  await expect(table).toBeVisible();

  // Both rows, with their derived slugs and the vocabulary-locked
  // visibility label ("Space", not "workspace").
  await expect(page.getByRole("cell").filter({ hasText: "Launch checklist" })).toBeVisible();
  await expect(page.getByText("launch-checklist", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell").filter({ hasText: "Meridian field notes" })).toBeVisible();
  await expect(page.getByText("meridian-field-notes", { exact: true })).toBeVisible();
  await expect(page.getByText("Space", { exact: true }).first()).toBeVisible();
  // The deterministic YYYY-MM-DD `when` column (one per row).
  await expect(page.locator(".when").first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);

  await expectNoAxeViolations(page);
});
