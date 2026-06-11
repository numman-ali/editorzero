import { expect, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";

/**
 * Browser round-trip for the credential flow (ADR 0030 / 0033) against
 * the real stack: bundled trunk (SQLite + Better Auth) behind the Vite
 * dev proxy, so the browser sees one origin and the SameSite=Lax cookie
 * + trustedOrigins model is exercised exactly as in production.
 *
 * Serial: sign-up provisions the only account (and, per ADR 0041, the
 * workspace + owner membership — sign-up IS the fresh-install bootstrap);
 * the sign-in specs authenticate against it. The trunk webServer wipes
 * its tmp/ per run, so the suite is idempotent.
 */
test.describe.configure({ mode: "serial" });

const CREDENTIALS = {
  email: "founder@e2e.editorzero.test",
  password: "e2e-password-123",
  name: "Founding User",
};

test("an unauthenticated visit bounces to /login carrying the redirect target", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await expect(page.getByRole("heading", { name: "editorzero" })).toBeVisible();
});

test("the login screen passes axe in both modes", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "editorzero" })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole("button", { name: "Create one" }).click();
  await expect(page.getByLabel(/^name/i)).toBeVisible();
  await expectNoAxeViolations(page);
});

test("sign-up provisions the account and lands in the authed shell", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Create one" }).click();
  await page.getByLabel(/^email/i).fill(CREDENTIALS.email);
  await page.getByLabel(/^name/i).fill(CREDENTIALS.name);
  await page.getByLabel(/^password/i).fill(CREDENTIALS.password);
  await page.getByRole("button", { name: /create account/i }).click();
  // The authed shell frame: principal chip shows the bootstrapped owner.
  await expect(page).toHaveURL("/");
  await expect(page.locator(".side .foot .nm")).toHaveText("User");
  await expect(page.locator(".side .foot .rl")).toHaveText("OWNER");
  await expectNoAxeViolations(page);
});

test("a fresh session signs in and is returned to the guarded target", async ({ page }) => {
  // New test = new browser context = no cookies; the guard bounces and
  // records where we were headed, sign-in must honor it on the way back.
  await page.goto("/?probe=1");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.getByLabel(/^email/i).fill(CREDENTIALS.email);
  await page.getByLabel(/^password/i).fill(CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/?probe=1");
  await expect(page.locator(".side .foot .nm")).toHaveText("User");
});

test("a wrong password surfaces the server's message without navigating", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/^email/i).fill(CREDENTIALS.email);
  await page.getByLabel(/^password/i).fill("wrong-password-123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("alert")).toContainText(/invalid email or password/i);
  await expect(page).toHaveURL(/\/login/);
});
