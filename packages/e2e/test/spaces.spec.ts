import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: space.list
 * proves-capability-cell: space.get
 * proves-capability-cell: space.create
 *
 * The `space.list` + `space.get` × Web UI parity cells (invariant 4,
 * ADR 0033 §3 / 0040 H11). The marker lines above are load-bearing:
 * `packages/contract-tests` scans the e2e specs for
 * `proves-capability-cell:` and fails the build if a capability declares
 * `"ui"` without a spec carrying its marker — this file is what lets
 * the two space read capabilities declare the surface.
 *
 * The proof is end-to-end against real server data: the signup hook seeds
 * the founder's Personal space (ADR 0040 slice 2a), so the FIRST
 * assertion — "Personal" renders without this spec creating anything —
 * already proves the screen shows *server* state. Team spaces are then
 * created over the same HTTP API the other surfaces use (`POST
 * /spaces/create`) and asserted to render in the server's `name ASC`
 * order. No fixtures, no route mocking.
 *
 * The screen lives at the SINGULAR `/space`: `/spaces` is the trunk's
 * API domain and a reserved prefix (ADR 0035 §2) — same resolution as
 * the editor's `/doc/$docId` vs `/docs`.
 */
test.describe.configure({ mode: "serial" });

/** API sign-in via the page's own request context (the docs.spec pattern). */
async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

test("the signup-seeded Personal space renders without any spec-side setup", async ({ page }) => {
  await signIn(page);
  await page.goto("/space");
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();
  // The Personal card: name, kind chip ("Personal" appears in BOTH — scope
  // by class, plain getByText is a strict-mode violation), slug, and the
  // meta line carrying the seeded row truth (private · baseline view).
  await expect(page.locator(".sp .nm")).toHaveText(["Personal"]);
  await expect(page.locator(".sp .status-tag")).toHaveText(["Personal"]);
  await expect(page.getByText("personal", { exact: true })).toBeVisible();
  await expect(page.getByText("private · baseline view")).toBeVisible();
  await expectNoAxeViolations(page);
});

test("team spaces created over the API render in server order with kind chips", async ({
  page,
}) => {
  await signIn(page);
  // Create through the same capability surface (POST /spaces/create) the
  // API/CLI/MCP cells use — the UI cell must show *server* state.
  for (const [name, space_type] of [
    ["Engineering", "open"],
    ["Product", "closed"],
  ] as const) {
    const res = await page.request.post("/spaces/create", { data: { name, space_type } });
    expect(res.ok()).toBe(true);
  }

  await page.goto("/space");
  // name ASC, id ASC — the capability's ordering contract, visible here —
  // and the kind chips in the same card order (two minted Team rows
  // around the seeded Personal one).
  await expect(page.locator(".sp .nm")).toHaveText(["Engineering", "Personal", "Product"]);
  await expect(page.locator(".sp .status-tag")).toHaveText(["Team", "Personal", "Team"]);
  await expect(page.getByText("engineering", { exact: true })).toBeVisible();
  await expect(page.getByText("open · baseline view")).toBeVisible();
  await expect(page.getByText("closed · baseline view")).toBeVisible();

  // The sidebar nav entry reaches the same screen (the drawer/aside Link).
  await page.goto("/");
  await page.getByRole("link", { name: "Spaces" }).first().click();
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();

  await expectNoAxeViolations(page);
});

test("space.get: a card's name links to the detail screen rendering the server row", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/space");

  // The card NAME is the link into the detail screen (the docs-row idiom).
  await page.getByRole("link", { name: "Engineering" }).click();
  await expect(page).toHaveURL(/\/space\/[0-9a-f-]{36}$/u);

  // Header: name + slug + kind chip; body: the .kv fact rows rendering
  // the row space.get returns — type · baseline, then the audit dates.
  // Every value is server state minted by the create call in the
  // previous test; nothing here is seeded by this spec.
  await expect(page.locator("h2.t")).toHaveText("Engineering");
  await expect(page.locator(".pth")).toHaveText("engineering");
  await expect(page.locator(".status-tag")).toHaveText("Team");
  await expect(page.getByText("open · baseline view")).toBeVisible();
  await expect(page.locator(".kv .v.mono").first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/u);

  await expectNoAxeViolations(page);

  // The seeded Personal space resolves through the same gate (owner-only
  // visibility) — its detail renders the signup-seeded row.
  await page.goto("/space");
  await page.getByRole("link", { name: "Personal", exact: true }).click();
  await expect(page.locator("h2.t")).toHaveText("Personal");
  await expect(page.getByText("private · baseline view")).toBeVisible();
});

test("space.create: the header form mints a team space and lands on its detail", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/space");

  // Trigger morphs into the inline form; focus lands in the name input.
  await page.getByRole("button", { name: "+ New space" }).click();
  const input = page.getByRole("textbox", { name: "Space name" });
  await expect(input).toBeFocused();
  await input.fill("Design");
  await page.getByRole("combobox", { name: "Space type" }).selectOption("closed");
  await expectNoAxeViolations(page); // the open form is part of the audited surface
  await page.getByRole("button", { name: "Create" }).click();

  // create→detail: the new space's screen renders the minted row — the
  // meta line proves the SELECT traveled (closed, not the open default)
  // and the baseline stayed at the schema default.
  await expect(page).toHaveURL(/\/space\/[0-9a-f-]{36}$/u);
  await expect(page.locator("h2.t")).toHaveText("Design");
  await expect(page.locator(".pth")).toHaveText("design");
  await expect(page.locator(".status-tag")).toHaveText("Team");
  await expect(page.getByText("closed · baseline view")).toBeVisible();

  // Server state on the grid: the card joined in name-ASC order.
  await page.goto("/space");
  await expect(page.locator(".sp .nm")).toHaveText([
    "Design",
    "Engineering",
    "Personal",
    "Product",
  ]);

  // The 409 sibling-slug arm: an existing name refuses with the typed
  // alert and the form stays open for a different name.
  await page.getByRole("button", { name: "+ New space" }).click();
  await page.getByRole("textbox", { name: "Space name" }).fill("Engineering");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "+ New space" })).toBeVisible();
});
