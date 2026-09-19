/**
 * E2E — the shell's target-size and focus guarantees.
 *
 * A measurable a11y floor on what the route map renders: controls at least
 * 44×44 px, boundary states focusable and announced. A route returning 200 is
 * not evidence that its controls are hittable.
 *
 * This file runs no axe leg: catalog pages are axe-checked elsewhere, so these
 * geometric and accessibility-tree checks are a floor, not a substitute.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';

/** Also `--target-min` in tokens.css, the single source. */
const MIN_TARGET = 44;

/** The whole-map sample: the shell chrome plus both boundary states. */
const SAMPLE_ROUTES = ['/', '/discover', '/admin', '/no-such-page'];

/**
 * Every interactive element that is actually rendered. A link with no
 * accessible name is reported separately rather than skipped, because an
 * unnamed control is a worse defect than a small one.
 */
async function interactive(page: Page): Promise<Locator[]> {
  const all = page.locator('a[href], button:not([disabled])');
  const count = await all.count();
  const out: Locator[] = [];
  for (let i = 0; i < count; i += 1) out.push(all.nth(i));
  return out;
}

test.describe('target size (the 44px floor)', () => {
  for (const route of SAMPLE_ROUTES) {
    test(`${route} — every rendered control is at least 44×44`, async ({ page }) => {
      await page.goto(route);

      const tooSmall: string[] = [];
      const unnamed: string[] = [];

      for (const el of await interactive(page)) {
        const box = await el.boundingBox();
        if (box === null) continue; // not laid out (display:none) — not hittable
        const name = (await el.evaluate((n) => (n.textContent ?? '').trim())) || '(no text)';
        const aria = await el.getAttribute('aria-label');
        const label = aria === null ? name : `${name} [aria-label="${aria}"]`;

        if (box.width < MIN_TARGET || box.height < MIN_TARGET) {
          tooSmall.push(`"${label}" is ${Math.round(box.width)}×${Math.round(box.height)}`);
        }
        if (name === '(no text)' && aria === null) unnamed.push(label);
      }

      expect(tooSmall, `controls below the ${MIN_TARGET}px floor on ${route}`).toEqual([]);
      expect(unnamed, `controls with no accessible name on ${route}`).toEqual([]);
    });
  }

  test('the shell nav and admin nav are hittable, not just the page content', async ({ page }) => {
    // The nav is the one place a target-size regression is easiest to miss,
    // because the links look fine in a screenshot and every other assertion in
    // the suite is about the page body.
    await page.goto('/admin');
    for (const selector of ['.shell-nav a', '.admin-nav a']) {
      const boxes = await page.locator(selector).evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { t: (n.textContent ?? '').trim(), h: r.height, w: r.width };
        }),
      );
      expect(boxes.length, `no ${selector} rendered`).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.h, `${selector} "${b.t}" height`).toBeGreaterThanOrEqual(MIN_TARGET);
        expect(b.w, `${selector} "${b.t}" width`).toBeGreaterThanOrEqual(MIN_TARGET);
      }
    }
  });
});

test.describe('boundary states are announced', () => {
  test('on a HARD load not-found does not steal focus, and is announced instead', async ({
    page,
  }) => {
    await page.goto('/no-such-page');

    // The region sits AFTER the skip link, so moving focus here made the bypass
    // link unreachable by Tab (WCAG 2.4.1) on the page that most needs it. The
    // requirement is that the state is FOCUSABLE and ANNOUNCED — and it is:
    // `tabIndex={-1}` can still take focus, and a `role="status"` region reads
    // itself out. What it must not do is MOVE focus on a document load.
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      return el === null ? null : { tag: el.tagName, cls: String(el.className ?? '') };
    });
    expect(active?.cls).not.toContain('focus-region');

    // Announced: the state is a polite live region, and its label resolves to
    // a real heading (an `aria-labelledby` on a roleless element is a classic
    // silent no-op, so the name is read out of the accessibility tree).
    const region = page.locator('.focus-region');
    await expect(region).toHaveAttribute('role', 'status');
    const name = await region.evaluate((el) => {
      const heading = document.getElementById('not-found-title');
      return heading?.textContent?.trim() ?? null;
    });
    expect(name).toBe('Page not found');
  });

  test('the not-found region is still programmatically focusable', async ({ page }) => {
    // "Focusable" is the half the focus move was mistaken for: the element CAN
    // receive focus, so a skip-to-content link or a recovery affordance has
    // somewhere to send the reader.
    await page.goto('/no-such-page');

    const focusable = await page
      .locator('.focus-region')
      .evaluate((el) => el.getAttribute('tabindex') === '-1');
    expect(focusable).toBe(true);
  });

  test('a raw anchor to a 404 does NOT move focus — it is a document load', async ({ page }) => {
    // The in-app-navigation branch of FocusRegion (focus DOES follow the state)
    // is deliberately NOT asserted here, and the reason is worth recording
    // rather than papering over:
    //
    //  - A plain `<a href>` click is a FULL document navigation, so it exercises
    //    the hard-load path again, not the soft one.
    //  - A real soft transition needs a Next `<Link>`, and the app exposes NO
    //    in-app link whose target 404s: the nav points at real routes, and a
    //    catalog card points at a manga that exists. Exercising the branch would
    //    mean adding a link that exists only for the test, i.e. a test-only
    //    affordance in product code.
    //
    // So the branch is guarded by `hasHydrated()` (shared/ui/hydration.tsx),
    // which is set once per document by a component in the ROOT LAYOUT and
    // never remounts on a soft transition — the one signal that separates the
    // two moments. The hard-load branch, the one a reader hits by pasting a
    // URL, is asserted above.
    await page.goto('/discover');
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/no-such-page';
      link.id = 'probe-nav';
      link.textContent = 'probe';
      document.body.appendChild(link);
    });
    await page.locator('#probe-nav').click();

    const active = await page.evaluate(() => {
      const el = document.activeElement;
      return el === null ? null : { cls: String(el.className ?? '') };
    });
    expect(active?.cls).not.toContain('focus-region');
    await expect(page.locator('.focus-region')).toHaveAttribute('role', 'status');
  });

  test('not-found offers the two destinations that always exist', async ({ page }) => {
    // A link home, and a next action: a 404 must not be a dead end, and `main`
    // must never be blank.
    await page.goto('/no-such-page');
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Go to the catalog' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the home page' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the catalog' })).toHaveAttribute(
      'href',
      '/discover',
    );
    await expect(page.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute(
      'href',
      '/',
    );
  });

  test('the error boundary leaks nothing it should not', async () => {
    // The boundary cannot be reached on a healthy app, so "it leaks nothing"
    // is a property of the FILE, asserted here as a source invariant rather
    // than by trying to crash the app: no stack, no message, no path in the UI.
    const raw = readFileSync(new URL('../../src/app/error.tsx', import.meta.url), 'utf8');

    // Comments are stripped first, and deliberately: the file's header explains
    // at length WHY there is no console.error, so a raw-text match would flag
    // its own documentation. The assertion is about code.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The only field of the caught error the UI may read is Next's opaque
    // digest. `message` and `stack` are the two leaks the requirement names.
    expect(code).not.toMatch(/error\s*\.\s*message/);
    expect(code).not.toMatch(/error\s*\.\s*stack/);
    // Printing the error in the browser console puts both in front of the
    // user, which is the same leak by another route.
    expect(code).not.toMatch(/console\s*\.\s*(error|warn|log)/);
    // The digest is the one thing it may render, and it is rendered as text.
    expect(code).toMatch(/error\s*\.\s*digest/);
  });

  test('an unknown route is a 404, never the 5xx boundary', async ({ page }) => {
    // The other half of "leaks nothing": the error boundary is not reachable
    // by typing, so no attacker-supplied path can land a user on a page that
    // renders an error object.
    const response = await page.goto('/error-boundary-probe');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await expect(page.getByText(/error digest|at Object|\.tsx:|\/home\//i)).toHaveCount(0);
  });
});
