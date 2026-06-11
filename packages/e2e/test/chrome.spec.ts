import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * Responsive shell chrome (ADR 0036/0037): the primary nav on the static
 * desktop sidebar, and the Base UI Drawer that replaces it under the
 * 1120px breakpoint — without it the sidebar (and the principal chip with
 * it) is simply unreachable on mobile. No capability-cell marker here:
 * chrome is structure, not a capability binding.
 */
test.describe.configure({ mode: "serial" });

async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

test("desktop: the primary nav marks the documents screen current; no hamburger", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Primary" });
  const link = nav.getByRole("link", { name: "All Documents" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();
  await expectNoAxeViolations(page);
});

test("mobile: the hamburger opens the nav drawer (principal chip + nav), axe-clean, Escape closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");

  // Under the breakpoint the static sidebar is hidden — the drawer is the
  // only path to the nav + principal chip.
  await expect(page.locator("aside.side")).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).click();

  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link", { name: "All Documents" })).toBeVisible();
  await expect(drawer.locator(".foot .nm")).toHaveText("User");
  await expectNoAxeViolations(page);

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("mobile: choosing a nav entry closes the drawer and lands on the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await drawer.getByRole("link", { name: "All Documents" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("heading", { name: "Docs" })).toBeVisible();
});
