import { expect, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";

/**
 * Theme contract (ADR 0037): a persisted `ez-theme` localStorage value is
 * reflected as `html[data-theme]` — pre-paint by the index.html guard,
 * post-hydration by `lib/theme.ts`. The default (Meridian Zero light) is
 * the *absence* of the attribute. The storage key is hardcoded here the
 * same way index.html hardcodes it: it is part of the contract.
 */
test("the default theme is the absence of data-theme", async ({ page }) => {
  await page.goto("/login");
  // Render anchor first: the attribute is written pre-paint by the
  // index.html guard, so without waiting for real content the
  // assertion would pass against an empty #root (adversarial review
  // 2026-06-11 — the login chunk is code-split and lands post-load).
  await expect(page.getByRole("heading", { name: "editorzero" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
});

test("a persisted dark theme applies and the dark login passes axe", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ez-theme", "dark");
  });
  await page.goto("/login");
  // Same render anchor — axe against a blank dark-attributed page is a
  // vacuous green; the scan must see the actual login card.
  await expect(page.getByRole("heading", { name: "editorzero" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoAxeViolations(page);
});
