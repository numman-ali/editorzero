import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: doc.list
 * proves-capability-cell: doc.create
 *
 * The `doc.list × Web UI` parity cell and the `doc.create` cell's
 * "+ New doc" form (invariant 4, ADR 0033 §3 / 0040 H11). The marker
 * lines above are load-bearing: `packages/contract-tests` scans the e2e
 * specs for `proves-capability-cell:` and fails the build if a capability
 * declares `"ui"` without a spec carrying its marker — this file is what
 * lets `doc.list` and `doc.create` declare the surface.
 *
 * The proof is end-to-end against real server data: the suite signs in as
 * the genesis founder (created by `auth.spec.ts` — files run
 * alphabetically, single worker), asserts the EMPTY state first (fresh
 * SQLite per run, and nothing before this file creates docs), then creates
 * docs over the same HTTP API the other surfaces use and asserts the
 * screen renders them. No fixtures, no route mocking — a hardcoded list
 * would fail here. The create cell drives the form instead: button →
 * title → the new doc's own editor, then back to the list for the
 * server-state proof; the 409 sibling-slug arm stays on-screen with the
 * typed alert.
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

test("docs created over the API render in the list with slug, access chip, and date", async ({
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
  // access-mode label ("Space", not the wire's "space" — ADR 0040).
  await expect(page.getByRole("cell").filter({ hasText: "Launch checklist" })).toBeVisible();
  await expect(page.getByText("launch-checklist", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell").filter({ hasText: "Meridian field notes" })).toBeVisible();
  await expect(page.getByText("meridian-field-notes", { exact: true })).toBeVisible();
  await expect(page.getByText("Space", { exact: true }).first()).toBeVisible();
  // The deterministic YYYY-MM-DD `when` column (one per row).
  await expect(page.locator(".when").first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);

  await expectNoAxeViolations(page);
});

test("the New doc form creates a doc and lands in its editor (doc.create cell)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");

  // The trigger morphs into the inline title form; focus lands in the
  // input (the disclosure announcement for keyboard/SR users).
  await page.getByRole("button", { name: "+ New doc" }).click();
  const titleInput = page.getByRole("textbox", { name: "Doc title" });
  await expect(titleInput).toBeFocused();
  await titleInput.fill("Drafted from the shell");
  await expectNoAxeViolations(page); // the open form is part of the audited surface

  await page.getByRole("button", { name: "Create", exact: true }).click();

  // Success navigates into the new doc's editor — the seeded title block
  // (heading/1 with the title text) is the first thing the user sees.
  await page.waitForURL(/\/doc\/[0-9a-f-]{36}$/u);
  await expect(
    page.getByRole("heading", { name: "Drafted from the shell", level: 1 }),
  ).toBeVisible();

  // Server-state proof: back on the list, doc.list returns the new doc.
  await page.goto("/");
  await expect(page.getByRole("cell").filter({ hasText: "Drafted from the shell" })).toBeVisible();
  await expect(page.getByText("drafted-from-the-shell", { exact: true })).toBeVisible();
});

test("a duplicate title surfaces the typed 409 alert without leaving the screen", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");

  await page.getByRole("button", { name: "+ New doc" }).click();
  // Same title as the previous test → same derived slug at the workspace
  // root → the capability's sibling-slug pre-check answers 409.
  await page.getByRole("textbox", { name: "Doc title" }).fill("Drafted from the shell");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("already exists");
  // Unretryable-as-typed: still on the list screen, form still open for a
  // different title.
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByRole("textbox", { name: "Doc title" })).toBeVisible();
});
