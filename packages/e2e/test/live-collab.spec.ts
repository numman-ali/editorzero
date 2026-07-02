import { expect, type Page, test } from "@playwright/test";

import { expectNoAxeViolations } from "./axe";
import { CREDENTIALS } from "./credentials";

/**
 * proves-capability-cell: doc.apply_update
 *
 * The live collab lane (ADR 0043 / ADR 0038): the doc screen's canvas
 * binds the server's Y.Doc over the `/collab` WebSocket, and every
 * browser keystroke travels as a Yjs delta that the WS write gate
 * dispatches through `doc.apply_update` — permission-checked, audited,
 * broadcast-after-commit. The proof here is end-to-end against the
 * real trunk:
 *
 *  - a second tab on the same doc receives the typed line LIVE (no
 *    reload — only the post-commit broadcast can deliver it);
 *  - Enter splits (end-of-block AND mid-block) broadcast as NEW blocks
 *    with the session still Live: the id attribute is `keepOnSplit:
 *    false`, so the split-off block ships id-less and the server mints
 *    — before that fix the copied id tripped the write gate's
 *    `duplicate_block_id` refusal and the session reset-looped;
 *  - the audit trail carries `doc.apply_update` allow rows for the
 *    edit (the lane is the dispatcher, not a raw socket);
 *  - a full reload renders the content from the server's persisted
 *    Y.Doc (`doc_updates` rows committed by the audited write path);
 *  - blocking the WS upgrade degrades the screen to the HTTP-first
 *    Save editor (the `doc.update` cell — editor.spec.ts pins that
 *    lane in depth);
 *  - sign-out closes the live socket with the 4401 revocation contract
 *    (ADR 0043 Decision 5) and the canvas surfaces the re-auth notice
 *    instead of blind-retrying.
 *
 * NAMED live-collab.spec.ts ON PURPOSE — NOT collab.spec.ts. Specs run
 * alphabetically in one worker against one shared SQLite file, and
 * docs.spec.ts opens on the workspace's EMPTY docs-panel state before
 * creating its fixtures ("Launch checklist" — editor.spec.ts's 409
 * collision target). A `collab*` filename sorts before `docs` and this
 * spec's doc would break that empty-state proof; the l-slot lands after
 * both, where one more doc in the panel is inert.
 */
test.describe.configure({ mode: "serial" });

const DOC_TITLE = "Collab proving ground";
const LIVE_LINE = "Typed live over the WS lane.";
const SPLIT_LINE = "Enter mints a fresh block id.";
/** Suffix of SPLIT_LINE — the cursor walks left over it to split mid-block. */
const MID_SPLIT_TAIL = "block id.";

async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/auth/sign-in/email", {
    data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
  });
  expect(res.ok()).toBe(true);
}

async function openDoc(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: DOC_TITLE }).click();
  await expect(page).toHaveURL(/\/doc\/[0-9a-f-]+$/u);
}

test("doc.apply_update: a typed edit broadcasts live to a second tab, lands on the audit trail, and survives reload", async ({
  page,
  context,
}) => {
  await signIn(page);
  const res = await page.request.post("/docs/create", { data: { title: DOC_TITLE } });
  expect(res.ok()).toBe(true);

  await openDoc(page);
  // The canvas mounts only after the first sync; "Live" is the
  // editable phase (collab-doc-editor.tsx).
  await expect(page.getByRole("status")).toHaveText("Live");
  const surface = page.locator(".doc-editor-surface");
  await expect(surface).toHaveAttribute("contenteditable", "true");
  await expect(surface.locator("h1")).toHaveText(DOC_TITLE);

  // Second tab, same user, own WebSocket — the broadcast audience.
  const pageB = await context.newPage();
  await openDoc(pageB);
  await expect(pageB.getByRole("status")).toHaveText("Live");
  const surfaceB = pageB.locator(".doc-editor-surface");
  await expect(surfaceB.locator("h1")).toHaveText(DOC_TITLE);

  // Type into the seeded empty paragraph. No Save control exists on
  // this lane — persistence IS the per-delta audited dispatch.
  await surface.locator("p").last().click();
  await page.keyboard.type(LIVE_LINE);

  // The line arrives in tab B without any navigation: only the
  // post-commit broadcast (ADR 0043 Decision 1) can put it there.
  await expect(surfaceB.locator("p").first()).toHaveText(LIVE_LINE);

  // REGRESSION (2026-07-02): splitting a block must NOT copy its id.
  // Tiptap's splitBlock copies attributes onto the new node unless the
  // attribute opts out; before `keepOnSplit: false` the split-off block
  // carried its sibling's id, the WS write gate refused the update
  // (`duplicate_block_id`), and the refused delta re-offered on every
  // resync — "The live session was reset by the server", unrecoverable
  // without a reload. Both split shapes must broadcast as new
  // server-minted blocks with the session still Live.
  await page.keyboard.press("Enter");
  await page.keyboard.type(SPLIT_LINE);
  await expect(surfaceB.locator("p")).toHaveCount(2);
  await expect(surfaceB.locator("p").nth(1)).toHaveText(SPLIT_LINE);

  // Mid-block split: same copied-attrs vector, both halves non-empty.
  for (let i = 0; i < MID_SPLIT_TAIL.length; i += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  await page.keyboard.press("Enter");
  await expect(surfaceB.locator("p")).toHaveCount(3);
  await expect(page.getByRole("status")).toHaveText("Live");
  await expect(pageB.getByRole("status")).toHaveText("Live");

  // The lane is the dispatcher: the keystrokes produced audited
  // doc.apply_update allow rows. (`/audits` — the API domain; the
  // singular `/audit` is the client trail screen.)
  const audit = await page.request.get("/audits/list?capability_id=doc.apply_update&limit=50");
  expect(audit.ok()).toBe(true);
  const body: { events: { capability_id: string; outcome: string }[] } = await audit.json();
  const allows = body.events.filter(
    (event) => event.capability_id === "doc.apply_update" && event.outcome === "allow",
  );
  expect(allows.length).toBeGreaterThan(0);

  // Reload renders from the server's persisted Y.Doc — the in-memory
  // editor state died with the page.
  await pageB.reload();
  await expect(pageB.locator(".doc-editor-surface").locator("p").first()).toHaveText(LIVE_LINE);
  await pageB.close();

  await expectNoAxeViolations(page);
});

test("the screen degrades to the HTTP Save editor when the WS lane is unavailable", async ({
  page,
}) => {
  await signIn(page);
  // Close the upgrade before any page script runs: the provider's
  // first pre-sync close is decisive (lib/collab.ts — no retry limbo).
  await page.routeWebSocket(/\/collab$/u, (ws) => {
    ws.close({ code: 4000, reason: "e2e: collab lane blocked" });
  });

  await openDoc(page);
  // The fallback IS the doc.update editor: explicit Save toolbar over
  // the loader-cached blocks, fully editable.
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  const surface = page.locator(".doc-editor-surface");
  await expect(surface).toHaveAttribute("contenteditable", "true");
  await expect(surface.locator("h1")).toHaveText(DOC_TITLE);
});

// LAST in the file: signing out revokes the session this page runs on.
test("sign-out closes the live socket with the revocation contract (4401) and the canvas asks for re-auth", async ({
  page,
}) => {
  await signIn(page);
  await openDoc(page);
  await expect(page.getByRole("status")).toHaveText("Live");

  // Better Auth destroys the session; the trunk's onAuthRevoked arm
  // closes the registered socket with 4401 (ADR 0043 Decision 5). The
  // provider must NOT blind-retry — the reducer goes terminal and the
  // re-auth notice renders with the frozen canvas. In-page fetch: the
  // endpoint enforces a browser Origin (MISSING_OR_NULL_ORIGIN on
  // header-less clients), and this is the exact shape a future
  // sign-out control will use.
  const status = await page.evaluate(async () => {
    const res = await fetch("/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return res.status;
  });
  expect(status).toBe(200);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Your session ended");
  await expect(alert.getByRole("link", { name: "Sign in" })).toBeVisible();
  // The frozen canvas is read-only (ADR 0039: no offline-write lane).
  await expect(page.locator(".doc-editor-surface")).toHaveAttribute("contenteditable", "false");
});
