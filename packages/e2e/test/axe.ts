import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Freeze every CSS transition + animation before an a11y scan.
 *
 * Contrast (WCAG SC 1.4.3) is judged on an element's RESTING state, but
 * axe samples computed colors at one instant — so a scan that lands inside
 * a `transition:` window reads a mid-interpolation BLEND of two endpoints
 * and reports a phantom failure that neither resting state has. The publish
 * toggle is the witness: it morphs `btn--ultra`→`btn--ghost` over 120ms
 * (white-on-cobalt #fff/#1f3cff → ink-on-surface #2a323d/#fff); at ~77%
 * progress BOTH channels blend to #5b616a on #cbd1fc = 4.18:1, tripping the
 * 4.5:1 rule for that single frame while both endpoints pass comfortably.
 * Snapping all durations/delays to 0s removes the window entirely, so the
 * scan is deterministic against the resting state — tightening the gate's
 * reliability, not loosening its rule.
 */
async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      animation-iteration-count: 1 !important;
    }`,
  });
}

/**
 * WCAG 2.1 AA gate (verification stack step 7). Failing the assertion
 * prints the violation objects — id, impact, and the offending nodes —
 * straight from axe-core.
 */
export async function expectNoAxeViolations(page: Page): Promise<void> {
  await freezeMotion(page);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}
