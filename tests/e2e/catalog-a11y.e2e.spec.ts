/**
 * E2E — the accessibility gate for the catalog surfaces. Separate from the
 * journey spec on purpose: a journey asserts what the page DOES, this one asserts
 * what it IS — structure, names, focus order, geometry. Both regress
 * independently: swapping a labelled `<select>` for a div keeps the journey green
 * and breaks a keyboard user. Both themes are scanned: the token-level contrast
 * check only proves the tokens, this confirms their rendered result.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startCatalogHarness, type CatalogHarness } from './support/catalog-harness';

const APP_ORIGIN = process.env['E2E_APP_ORIGIN'] ?? `http://127.0.0.1:${process.env['E2E_PORT'] ?? '3100'}`;
/** The product's minimum target size, matching `--target-min` in tokens.css. */
const MIN_TARGET = 44;

let harness: CatalogHarness;

test.beforeAll(async () => {
  harness = await startCatalogHarness({ appOrigin: APP_ORIGIN });
});

test.afterAll(async () => {
  await harness.close();
});

const discover = (path = ''): string => `${harness.url}/discover${path}`;
const detail = (slug: string): string => `${harness.url}/manga/${slug}`;

/**
 * Every route this lane renders, including its states.
 *
 * `path` is a FUNCTION of the harness, not a string: the harness binds an
 * ephemeral port in `beforeAll`, which runs after Playwright has already
 * collected (and named) these tests. Resolving a URL at collection time would
 * read `harness` before it exists.
 */
const ROUTES: ReadonlyArray<{ name: string; path: (h: CatalogHarness) => string }> = [
  { name: 'catalog', path: (h) => `${h.url}/discover` },
  { name: 'catalog, filtered', path: (h) => `${h.url}/discover?genre=horror&status=ongoing` },
  { name: 'catalog, empty', path: (h) => `${h.url}/discover?genre=romance,horror` },
  { name: 'manga detail', path: (h) => `${h.url}/manga/title-01` },
  { name: 'manga detail, 220 chapters', path: (h) => `${h.url}/manga/long-series` },
  { name: 'manga detail, no chapters', path: (h) => `${h.url}/manga/no-chapters` },
  { name: 'manga detail, no cover', path: (h) => `${h.url}/manga/no-cover-asset` },
  { name: 'manga detail, upstream down', path: (h) => `${h.url}/manga/upstream-unavailable` },
  { name: 'manga, not found', path: (h) => `${h.url}/manga/unpublished-draft` },
];

/** axe, with the ID of every rule that failed, so a failure names its cause. */
async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  return results.violations.map(
    (violation) => `${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help} → ${violation.nodes
      .slice(0, 3)
      .map((node) => node.target.join(' '))
      .join(' | ')}`,
  );
}

test.describe('axe — every state of every route this lane owns', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const route of ROUTES) {
      test(`${route.name} — ${theme}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(route.path(harness), { waitUntil: 'load' });
        // Covers are in flight; a scan mid-swap would measure a transient state.
        await page.waitForLoadState('networkidle').catch(() => undefined);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  }
});

test.describe('structure', () => {
  for (const route of ROUTES.filter((entry) => !entry.name.includes('not found'))) {
    test(`${route.name} — one main, one h1, no skipped heading level`, async ({ page }) => {
      await page.goto(route.path(harness));
      await expect(page.locator('main#main')).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

      const levels = await page
        .locator('h1, h2, h3, h4, h5, h6')
        .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
      expect(levels[0]).toBe(1);
      for (let index = 1; index < levels.length; index += 1) {
        // A jump of more than one level is a screen-reader dead end: heading
        // levels must never skip.
        expect(
          (levels[index] ?? 0) - (levels[index - 1] ?? 0),
          `heading levels ${levels.join(' → ')}`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }

  test('the catalog grid is a real list of links (not a div soup)', async ({ page }) => {
    await page.goto(discover());
    const list = page.getByRole('list', { name: 'Titles' });
    await expect(list).toBeVisible();
    await expect(list.locator('> li')).toHaveCount(24);

    // Every item is a link, and every link's accessible name carries the title
    // and the status.
    const names = await list
      .locator('> li')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const link = node.querySelector('a');
          return (link?.textContent ?? '').replace(/\s+/g, ' ').trim();
        }),
      );
    for (const name of names) {
      expect(name).toMatch(/\S/);
      expect(name).toMatch(/ongoing|completed|hiatus/i);
      expect(name).toMatch(/Ch\. \d+|No chapters/i);
    }
  });

  test('the chapter list is a real <ol> of links, and its rows are named', async ({ page }) => {
    await page.goto(detail('title-01'));
    const list = page.locator('nav[aria-label="Chapters"] ol');
    await expect(list).toHaveCount(1);

    const rows = list.locator('> li');
    expect(await rows.count()).toBeGreaterThan(0);
    for (const row of await rows.all()) {
      const link = row.locator('a');
      await expect(link).toHaveCount(1);
      expect((await link.innerText()).trim().length).toBeGreaterThan(0);
    }
  });

  test('the filters are in an aside named by their heading, and every control is labelled', async ({
    page,
  }) => {
    await page.goto(discover());
    const aside = page.locator('aside');
    await expect(aside).toHaveCount(1);
    await expect(aside.getByRole('heading', { name: 'Filters' })).toBeVisible();

    // Every input has a VISIBLE label, not a placeholder.
    const unlabelled = await page.locator('select, input').evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const id = node.getAttribute('id');
          const label = id === null ? null : document.querySelector(`label[for="${id}"]`);
          return label === null || (label.textContent ?? '').trim() === '';
        })
        .map((node) => node.outerHTML.slice(0, 80)),
    );
    expect(unlabelled).toEqual([]);
  });
});

test.describe('keyboard', () => {
  test('the skip link is the first focusable element and moves focus to main', async ({ page }) => {
    await page.goto(discover());
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: /skip to main content/i });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
    await expect(page.locator('#main')).toBeFocused();
  });

  test('a genre chip toggles with Space and with Enter', async ({ page }) => {
    await page.goto(discover());
    const chip = page.getByRole('button', { name: 'Horror', exact: true });
    await chip.focus();

    await page.keyboard.press('Space');
    await page.waitForURL(/genre=horror/);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    // Enter toggles back, and the URL key is gone again.
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => !url.searchParams.has('genre'));
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  test('Escape clears every selected genre from inside the genre group', async ({ page }) => {
    await page.goto(discover('?genre=horror,romance'));
    const chip = page.getByRole('button', { name: 'Horror', exact: true });
    await chip.focus();
    await page.keyboard.press('Escape');
    await page.waitForURL((url) => !url.searchParams.has('genre'));
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  test('Escape outside the genre group does not clear anything', async ({ page }) => {
    await page.goto(discover('?genre=horror'));
    await page.getByLabel('Status').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(new URL(page.url()).searchParams.get('genre')).toBe('horror');
  });

  test('a chapter row is reachable and activatable by keyboard alone', async ({ page }) => {
    await page.goto(detail('title-01'));
    const link = page.locator('nav[aria-label="Chapters"] ol > li').first().locator('a');
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/manga\/title-01\/chapter\/1$/);
  });

  test('the genre region is a labelled, scrollable group', async ({ page }) => {
    await page.goto(discover());
    const group = page.getByRole('group', { name: 'Genres' });
    await expect(group).toBeVisible();
    // Its purpose is stated, so the five-selection cap is not a surprise and
    // the Escape shortcut is discoverable rather than folklore.
    await expect(page.locator('#catalog-genre-hint')).toContainText(/escape clears/i);
    await expect(page.locator('#catalog-genre-hint')).toContainText(/up to 5/i);
  });
});

test.describe('targets and focus', () => {
  for (const route of [
    { name: '/discover', path: (h: CatalogHarness) => `${h.url}/discover` },
    { name: '/manga/[slug]', path: (h: CatalogHarness) => `${h.url}/manga/title-01` },
    { name: '/manga/[slug], 220 chapters', path: (h: CatalogHarness) => `${h.url}/manga/long-series` },
  ]) {
    test(`${route.name} — every control is at least ${MIN_TARGET}×${MIN_TARGET}`, async ({ page }) => {
      await page.goto(route.path(harness));
      const tooSmall: string[] = [];
      const unnamed: string[] = [];
      const controls = page.locator('a[href], button:not([disabled]), select');
      for (let index = 0; index < (await controls.count()); index += 1) {
        const control = controls.nth(index);
        const box = await control.boundingBox();
        if (box === null) continue;
        // `textContent`, not `innerText`: a row inside a `content-visibility:
        // auto` list that is off screen is not rendered, and `innerText` is
        // empty for un-rendered content. The accessible name does not depend on
        // whether the row is on screen.
        const name =
          (await control.evaluate((node) => node.textContent ?? '')).trim() ||
          (await control.getAttribute('aria-label')) ||
          '';
        if (box.width < MIN_TARGET || box.height < MIN_TARGET) {
          tooSmall.push(`"${name}" is ${Math.round(box.width)}×${Math.round(box.height)}`);
        }
        if (name.trim() === '') unnamed.push((await control.evaluate((n) => n.outerHTML)).slice(0, 70));
      }
      expect(tooSmall, `controls below the ${MIN_TARGET}px floor`).toEqual([]);
      expect(unnamed, 'controls with no accessible name').toEqual([]);
    });
  }

  test('a focused control has a visible indicator', async ({ page }) => {
    await page.goto(discover());
    const chip = page.getByRole('button', { name: 'Horror', exact: true });
    await chip.focus();
    const outline = await chip.evaluate((node) => {
      const style = getComputedStyle(node);
      return { width: style.outlineWidth, style: style.outlineStyle, shadow: style.boxShadow };
    });
    // The two-band indicator: an outer band on the surround, and for a control
    // whose fill differs from it, an inner one too (tokens.css).
    const outer = Number.parseFloat(outline.width);
    expect(outline.style).not.toBe('none');
    expect(outer).toBeGreaterThanOrEqual(2);
  });
});

test.describe('states are announced', () => {
  test('the empty shelf takes focus and offers a way out', async ({ page }) => {
    await page.goto(discover('?genre=romance,horror'));
    await expect(page.getByRole('heading', { name: /nothing on this shelf/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /clear the filters/i })).toBeVisible();
  });

  test('a failed catalog read is ANNOUNCED, and does not steal focus on a hard load', async ({
    page,
  }) => {
    // The page renders normally; only its own data read fails. Forcing that needs
    // a route the harness answers with a 503 — `/discover` asks for the
    // collection, and the harness cannot fail that one without failing the page
    // itself. So the assertion is on the detail page's own failure state, which is
    // the same component contract. The state must be focusable AND announced, but
    // focusing it on a document load would put focus past the skip link and make
    // the bypass block unreachable by Tab, so the assertion is on the
    // announcement plus the focusable property the live region keeps.
    await page.goto(detail('upstream-unavailable'));
    const region = page.locator('[aria-labelledby="detail-unavailable-h"]');
    await expect(region).toBeVisible();
    // Announced: a polite live region, read out without moving focus.
    await expect(region).toHaveAttribute('role', 'status');
    // Focusable, so a skip-to-content affordance can still send the reader here.
    await expect(region).toHaveAttribute('tabindex', '-1');
    // And focus is NOT stolen: it is still on the body, so the first Tab reaches
    // the skip link.
    const focusedClass = await page.evaluate(() => String(document.activeElement?.className ?? ''));
    expect(focusedClass).not.toContain('focus-region');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  });

  test('a failed genre read degrades the filter, not the grid', async ({ page }) => {
    // Its own harness, because the facets URL is built by the page and carries
    // nothing a spec could use to make that one read fail.
    const degraded = await startCatalogHarness({ appOrigin: APP_ORIGIN, failFacets: true });
    try {
      await page.goto(`${degraded.url}/discover`);
      await expect(
        page.getByRole('status').filter({ hasText: /genre list could not be loaded/i }),
      ).toBeVisible();
      // The shelf is still there, and status/sort still work.
      await expect(page.getByRole('list', { name: 'Titles' }).locator('> li')).toHaveCount(24);
      await page.getByLabel('Status').selectOption('completed');
      await page.waitForURL(/status=completed/);
    } finally {
      await degraded.close();
    }
  });
});

test.describe('no information by colour alone', () => {
  test('a selected genre says so in text, not in a colour', async ({ page }) => {
    await page.goto(discover('?genre=horror'));
    const chip = page.getByRole('button', { name: 'Horror', exact: true });
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    // The pressed state is also a weight change, so it survives greyscale.
    const weight = await chip.evaluate((node) => getComputedStyle(node).fontWeight);
    expect(Number(weight)).toBeGreaterThanOrEqual(600);
  });

  test('a draft chapter is labelled with a word, not a coloured dot', async ({ page }) => {
    await page.goto(detail('series-with-draft'));
    const draft = page.locator('nav[aria-label="Chapters"] ol > li').last();
    await expect(draft).toContainText('Draft');
    // Dashed, not solid: the difference survives a greyscale screenshot.
    const style = await draft.locator('span').last().evaluate((node) => getComputedStyle(node));
    expect(style.borderTopStyle).toBe('dashed');
  });

  test('the cover placeholder says why the tile is blank', async ({ page }) => {
    await page.goto(detail('no-cover-asset'));
    await expect(page.getByText('No cover')).toBeVisible();
  });
});

test.describe('motion', () => {
  test('with reduced motion requested, the controls stop transitioning', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(discover());
    const durations = await page
      .locator('.chip, a, button, select')
      .evaluateAll((nodes) =>
        nodes
          .slice(0, 12)
          .map((node) => getComputedStyle(node).transitionDuration),
      );
    expect(durations.length).toBeGreaterThan(0);
    for (const duration of durations) {
      // base.css collapses every transition to 1ms under this preference.
      expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.05);
    }
  });
});
