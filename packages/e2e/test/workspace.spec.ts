import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: workspace.get
 * proves-capability-cell: workspace.update
 *
 * The `workspace.get × Web UI` parity cell (invariant 4, ADR 0033 §3 /
 * 0040 H11): the sidebar workspace IDENTITY block, rendered on every
 * authed screen by the `_authed` layout. The marker line above is
 * load-bearing — `packages/contract-tests` binds the capability's `"ui"`
 * declaration to this spec.
 *
 * The proof is against real server data with zero spec-side setup: the
 * genesis bootstrap (ADR 0041) derives the workspace name from the
 * founder's email local-part (`founder@…` → "founder's workspace"), so
 * the name assertion pins server-derived state end-to-end. The slug
 * carries a workspace-id suffix (`composeWorkspaceSlug`) that is fresh
 * per run — assert its deterministic prefix only.
 */
test.describe.configure({ mode: "serial" });

/** API sign-in via the page's own request context (the docs.spec pattern). */
async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

test("the sidebar identity block renders the bootstrap-derived workspace name", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  const block = page.locator("aside.side .ws");
  await expect(block.locator(".nm")).toHaveText("founder's workspace");
  // Monogram letter + the slug's deterministic prefix (suffix is minted
  // per run from the workspace id).
  await expect(block.locator(".av")).toHaveText("F");
  await expect(block.locator(".sub")).toHaveText(/^founder-/);
  await expectNoAxeViolations(page);
});

test("mobile: the drawer carries the same identity block (shared SideContent)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer.locator(".ws .nm")).toHaveText("founder's workspace");
  await expectNoAxeViolations(page);
});

test("workspace.update: the identity block links to /workspace; the Edit form patches name + retention and the sidebar re-renders", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");

  // The identity block's one interaction: into the settings screen.
  await page.locator("aside.side .ws").click();
  await expect(page).toHaveURL(/\/workspace$/u);
  await expect(page.locator("h2.t")).toHaveText("founder's workspace");
  await expect(page.getByText(/^\d+ days$/u)).toBeVisible();

  await page.getByRole("button", { name: "Edit workspace" }).click();
  const nameInput = page.getByRole("textbox", { name: "Workspace name" });
  await expect(nameInput).toBeFocused();
  await nameInput.fill("Mission Control");
  await page.getByRole("spinbutton", { name: "Trash retention days" }).fill("14");
  await expectNoAxeViolations(page); // the open form is part of the audited surface
  await page.getByRole("button", { name: "Save" }).click();

  // One PATCH, three visible effects: the screen header, the facts row,
  // and the SIDEBAR identity block — the layout reads workspace.get
  // reactively, so the invalidation re-renders chrome this screen does
  // not own.
  await expect(page.locator("h2.t")).toHaveText("Mission Control");
  await expect(page.getByText("14 days")).toBeVisible();
  await expect(page.locator("aside.side .ws .nm")).toHaveText("Mission Control");
  await expect(page.locator("aside.side .ws .av")).toHaveText("M");

  // Server-state proof: a full reload renders the patched row.
  await page.reload();
  await expect(page.locator("h2.t")).toHaveText("Mission Control");
  await expect(page.getByText("14 days")).toBeVisible();
});
