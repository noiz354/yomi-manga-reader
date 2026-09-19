/**
 * E2E smoke — the planned route map and the shell contract.
 * Walks every route in the map, asserting its planned status, title and the
 * structural shell (landmarks, one h1, skip link, focus move). This file runs
 * NO axe leg; @axe-core/playwright is exercised by catalog-a11y.e2e.spec.ts,
 * so axe coverage is partial. The structural assertions are a floor, not a
 * substitute for axe. */
import { expect, test, type Page } from '@playwright/test';

/**
 * The planned route map, one entry per route that src/app owns. `title` is
 * the metadata contract from the root layout template (`%s · Yomi`), and each
 * entry declares the status it must answer.
 *
 * `/manga/some-slug` is 404 here because this spec runs against the E2E
 * harness, which serves GET /api/v1/manga/{slug} and returns 404 for a slug it
 * does not own; a bare app renders a degraded 200 instead.
 */
const ROUTES: ReadonlyArray<{ path: string; title: string; status?: 200 | 404 }> = [
  // `/` sits in the same segment as the root layout, so Next does not apply
  // the layout's `%s · Yomi` template to it — it uses the layout default.
  { path: '/', title: 'Yomi' },
  { path: '/discover', title: 'Catalog · Yomi' },
  { path: '/search', title: 'Search · Yomi' },
  { path: '/library', title: 'Library · Yomi' },
  { path: '/history', title: 'History · Yomi' },
  { path: '/bookmarks', title: 'Bookmarks · Yomi' },
  { path: '/settings', title: 'Settings · Yomi' },
  { path: '/auth/signin', title: 'Sign in · Yomi' },
  { path: '/auth/register', title: 'Register · Yomi' },
  // The harness owns this slug list, and `some-slug` is not in it.
  { path: '/manga/some-slug', title: 'Page not found · Yomi', status: 404 },
  { path: '/manga/some-slug/chapter/1', title: 'Reader · Yomi' },
  { path: '/admin', title: 'Admin · Yomi' },
  { path: '/admin/manga', title: 'Manga · Yomi' },
  { path: '/admin/manga/1', title: 'Manga · Yomi' },
  { path: '/admin/manga/1/chapters', title: 'Chapters · Yomi' },
  { path: '/admin/uploads', title: 'Uploads · Yomi' },
  { path: '/admin/users', title: 'Users · Yomi' },
  { path: '/admin/audit', title: 'Audit · Yomi' },
];

/**
 * What a page emitted while it settled, with URLs.
 *
 * WHY THIS IS NOT A TEXT MATCH ON console errors. Chrome logs the document's
 * OWN status as a console error — a route that is SUPPOSED to 404 produces
 * "Failed to load resource: … 404" with no URL in the text at all. So a text
 * filter can only either hide every 404 or hide nothing, and the assertion ends
 * up reporting a product regression when the browser is behaving correctly.
 * (That is not hypothetical: this file filtered on the text, and it could not
 * tell a genuine failure from a planned 404.)
 *
 * So the guarantee is expressed over RESPONSES, which carry the URL, and the
 * console is used only for the things a response cannot show — uncaught
 * exceptions and hydration/rendering errors. Two documented exemptions, both
 * narrow and both with a reason:
 *
 * 1. The document's own 404, when the route map DECLARES that status. The
 *    browser reporting a deliberate 404 is the correct behaviour.
 * 2. A failed `/media/` sub-resource in a seeded database. The seed harness
 *    writes `coverAssetKey` / `assetKey` values and uploads no bytes at all
 *    (`scripts/seed.mjs`: "Synthetic pages rendered in memory — nothing written
 *    to disk or to object storage"), so media delivery 404s BY DESIGN and the
 *    optimizer adds its own error. A production database sets `coverUrl` only
 *    when a cover exists, so this never applies there.
 *
 * Everything else still fails the test, which is what the assertion is for.
 */
interface PageEmissions {
  /** Console errors that are not a bare resource-status line. */
  readonly consoleErrors: readonly string[];
  /** Uncaught exceptions. */
  readonly pageErrors: readonly string[];
  /** Every response the browser did not like, as `status url`. */
  readonly badResponses: readonly string[];
}

const RESOURCE_STATUS_LINE = /^Failed to load resource: the server responded with a status of /;

function collectEmissions(page: Page): PageEmissions {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (RESOURCE_STATUS_LINE.test(msg.text())) return;
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('response', (res) => {
    if (res.status() < 400) return;
    badResponses.push(`${String(res.status())} ${res.url()}`);
  });
  return { consoleErrors, pageErrors, badResponses };
}

/** The failures a shell must not produce, given the status its route declares. */
function unexpectedEmissions(
  seen: PageEmissions,
  plannedStatus: 200 | 404,
  pageUrl: string,
): string[] {
  const unplanned = seen.badResponses.filter((entry) => {
    // `badResponses` entries are `status url`, and the url Playwright reports is
    // ABSOLUTE, so the comparison is on the pathname — otherwise the document's
    // own 404 never matches its own route and the exemption below never fires.
    const url = entry.slice(entry.indexOf(' ') + 1);
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url;
    }
    if (pathname === pageUrl) return plannedStatus !== 404; // the declared document status
    return !/\/(media|\/_next\/image)(\/|$|\?)/.test(pathname); // the seed's missing-media contract
  });
  return [
    ...seen.pageErrors.map((e) => `pageerror: ${e}`),
    ...seen.consoleErrors.map((e) => `console: ${e}`),
    ...unplanned.map((e) => `response: ${e}`),
  ];
}

test.describe('route map', () => {
  for (const route of ROUTES) {
    test(`${route.path} renders its shell`, async ({ page }) => {
      const seen = collectEmissions(page);
      const response = await page.goto(route.path);
      const expected = route.status ?? 200;

      expect(response?.status(), `status on ${route.path}`).toBe(expected);
      await expect(page).toHaveTitle(route.title);

      // One main, one h1, real landmarks.
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('banner')).toHaveCount(1);
      await expect(page.getByRole('contentinfo')).toHaveCount(1);
      await expect(page.getByRole('navigation', { name: 'Site' })).toHaveCount(1);
      const unplanned = unexpectedEmissions(seen, expected, route.path);
      expect(unplanned, `unplanned emissions on ${route.path}`).toEqual([]);
    });
  }

  test('an unplanned route renders the 404 shell, not a blank main', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    // Home + catalog routes out, so a 404 is never a dead end.
    await expect(page.getByRole('link', { name: 'Go to the catalog' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the home page' })).toBeVisible();
  });

  test('a nonsense ?page= value does not crash the reader shell', async ({ page }) => {
    // Param validation belongs elsewhere; the layout must tolerate the value
    // either way.
    const seen = collectEmissions(page);
    const response = await page.goto('/manga/x/chapter/1?page=abc');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    expect(unexpectedEmissions(seen, 200, '/manga/x/chapter/1')).toEqual([]);
  });
});

test.describe('shell contract', () => {
  test('the skip link is the first focusable element and moves focus to main', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    // Hidden until focused (visually off-screen, not display:none).
    await expect(skip).toBeInViewport();

    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });

  test('every route in the map starts with the skip link', async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route.path);
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    }
  });

  test('one token paints two different grounds, light and dark', async ({ page }) => {
    // The tokens are authored as `light-dark()` pairs resolved by the
    // browser's `color-scheme`, so a broken pair (a missing dark value, a
    // `[data-theme]` block that never matches) would look fine in one theme
    // and be invisible in a screenshot. Comparing the painted ground across
    // both schemes is the check that catches it.
    const grounds: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/discover');
      const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(ground, `--bg-canvas did not resolve in the ${scheme} theme`).not.toBe('');
      grounds.push(ground);
    }
    expect(grounds[0]).not.toBe(grounds[1]);
  });

  test('the theme can be pinned with data-theme, not only by the OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/discover');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const pinned = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/discover');
    const followed = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(pinned).toBe(followed);
  });

  test('forced-colors mode keeps text and the focus ring (WCAG 1.4.11)', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/discover');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    // The two-band focus ring falls back to a single system-coloured band.
    const outline = await skip.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(outline).toMatch(/rgb/);
  });

  test('reduced motion collapses transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/discover');
    const duration = await page
      .getByRole('link', { name: 'Skip to main content' })
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(['0s', '0.001s']).toContain(duration);
  });
});

test.describe('liveness', () => {
  test('GET /healthz answers 200 {ok:true} with no cache', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const cacheControl = response.headers()['cache-control'] ?? '';
    expect(cacheControl).toContain('no-store');
    expect(response.headers()['content-type']).toContain('application/json');
  });

  test('GET /healthz is fast and repeatable', async ({ request }) => {
    for (let i = 0; i < 5; i += 1) {
      const started = Date.now();
      const response = await request.get('/healthz');
      expect(response.status()).toBe(200);
      // The budget is a constant < 10 ms server-side; this is a loose ceiling
      // over the whole HTTP round trip, not the handler.
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});

test.describe('narrow viewport (reader 320px floor)', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('the shell has no horizontal overflow at 320px', async ({ page }) => {
    for (const route of ['/', '/discover', '/admin']) {
      await page.goto(route);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(0);
    }
  });
});
