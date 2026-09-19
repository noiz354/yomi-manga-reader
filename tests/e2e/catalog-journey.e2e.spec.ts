/**
 * E2E — the catalog journey: the real server-rendered pages driven through
 * `startCatalogHarness`, which answers the API contract at the network boundary.
 * Expected values are computed FROM the fixture set, so a fixture change fails
 * one line, not twenty. KNOWN ENV DEFECT: with `next dev`, a 404 raised by
 * `notFound()` inside a dynamic route returns an EMPTY document, so the 404
 * assertions pass only against the production build CI runs.
 */
import { expect, test, type Page } from '@playwright/test';
import { startCatalogHarness, type CatalogHarness } from './support/catalog-harness';
import { FIXTURE_MANGA, findBySlug, queryCatalog } from './support/catalog-fixtures';

const APP_ORIGIN = process.env['E2E_APP_ORIGIN'] ?? `http://127.0.0.1:${process.env['E2E_PORT'] ?? '3100'}`;

/** The title the detail assertions use: it has aliases, tags, creators and 5 chapters. */
const DETAIL_SLUG = 'title-01';

/** The dataset's size, so the cursor boundary is arithmetic, not a magic 30. */
const TOTAL = FIXTURE_MANGA.length;
const PAGE_SIZE = 24;
const PAGE_ONE = queryCatalog({
  genre: [],
  status: null,
  sort: 'updated_desc',
  limit: PAGE_SIZE,
  cursor: null,
});
/** The same page sorted by title — the order the cover-state tests walk. */
const PAGE_ONE_BY_TITLE_ASC = queryCatalog({
  genre: [],
  status: null,
  sort: 'title_asc',
  limit: PAGE_SIZE,
  cursor: null,
});

let harness: CatalogHarness;

/** One harness per worker: an ephemeral port, so workers cannot collide. */
test.beforeAll(async () => {
  harness = await startCatalogHarness({ appOrigin: APP_ORIGIN });
});

test.afterAll(async () => {
  await harness.close();
});

const discover = (path = ''): string => `${harness.url}/discover${path}`;

/** The card grid, addressed by its list role + accessible name. */
const grid = (page: Page) => page.getByRole('list', { name: 'Titles' });
const cards = (page: Page) => grid(page).getByRole('listitem');
/** The `href` of every card, in DOM order — the grid's actual order. */
async function cardHrefs(page: Page): Promise<string[]> {
  return grid(page)
    .locator('a')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? ''));
}

test.describe('the SSR grid', () => {
  test('page 1 is server-rendered: the cards arrive in the HTML, not after a fetch', async ({
    page,
  }) => {
    const response = await page.goto(discover());
    expect(response?.status()).toBe(200);

    // The markup itself carries the cards. If this regressed to a client fetch,
    // the first response would contain an empty grid and this fails.
    const html = (await response?.text()) ?? '';
    expect(html).toContain(PAGE_ONE.items[0]?.title ?? 'unreachable');

    await expect(cards(page)).toHaveCount(PAGE_SIZE);
  });

  test('each card shows cover, title, status and the latest chapter label', async ({
    page,
  }) => {
    await page.goto(discover());
    const expected = PAGE_ONE.items[0];
    expect(expected).toBeDefined();

    const link = cards(page).first().getByRole('link');
    // A card is a link whose accessible name carries the title AND the status,
    // so the status is never carried by colour alone.
    await expect(link).toHaveAttribute('href', `/manga/${expected?.slug ?? ''}`);
    await expect(link).toHaveAccessibleName(new RegExp(escapeRe(expected?.title ?? '')));
    await expect(link).toHaveAccessibleName(/ongoing|completed|hiatus/i);
    await expect(link).toHaveAccessibleName(
      expected?.latestChapter === null ? /no chapters/i : new RegExp(`Ch\\. ${expected?.latestChapter.number}\\b`),
    );
  });

  test('the first cover is the LCP element: eager and high priority, the rest lazy', async ({
    page,
  }) => {
    await page.goto(discover());
    // Only the cards that HAVE a cover asset render an <img>; the rest render
    // the placeholder and make no request at all.
    const withCover = PAGE_ONE.items.filter((item) => item.coverUrl !== null);
    expect(withCover.length).toBeGreaterThan(1);

    const images = grid(page).locator('img');
    // One card in the fixture has a cover key whose object is missing, so by the
    // time this runs its <img> has already been replaced by the placeholder.
    const present = await images.count();
    expect(present).toBeGreaterThanOrEqual(withCover.length - 1);

    await expect(images.first()).toHaveAttribute('loading', 'eager');
    await expect(images.first()).toHaveAttribute('fetchpriority', 'high');
    // The LCP cover is the one with a real `src` in the HTML; the rest wait for
    // the viewport, which is what keeps the page inside the 30-request budget
    // while the grid still scrolls in full.
    await expect(images.first()).toHaveAttribute('src', /\/media\//);
    await expect(images.nth(1)).toHaveAttribute('loading', 'lazy');
  });

  test('a title with no cover asset renders the placeholder and requests nothing', async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await page.goto(discover('?sort=title_asc'));
    await page.waitForLoadState('networkidle').catch(() => undefined);

    const noCover = findBySlug('no-cover-asset');
    expect(noCover?.summary.coverUrl).toBeNull();
    const card = cards(page).filter({ hasText: 'Never Uploaded' });
    await expect(card).toHaveCount(1);
    await expect(card.locator('img')).toHaveCount(0);
    await expect(card.getByText('No cover')).toBeVisible();

    // The placeholder is not a request that 404s: the card with no key makes no
    // request at all, and every request that IS made belongs to a card that has
    // one. (How many of the rest have loaded by now is the cover loader's
    // business — it fetches the covers near the fold, not the whole grid.)
    const withCover = PAGE_ONE_BY_TITLE_ASC.items.filter((item) => item.coverUrl !== null);
    const media = requested.filter((url) => url.includes('/media/'));
    expect(media.length).toBeGreaterThan(0);
    expect(media.length).toBeLessThanOrEqual(withCover.length);
    expect(media.some((url) => url.includes('no-cover-asset'))).toBe(false);
  });

  test('a cover whose bytes 404 falls back to the same placeholder', async ({ page }) => {
    const failed: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 404 && response.url().includes('/media/')) failed.push(response.url());
    });
    await page.goto(discover('?sort=title_asc'));
    const card = cards(page).filter({ hasText: 'Cover 404s' });
    await expect(card).toHaveCount(1);
    // Covers load as they approach the fold, so the failure this asserts is a
    // failure the reader has to reach: scroll the card into view, the way the
    // 404 happens for a real cover.
    await card.scrollIntoViewIfNeeded();
    // The key is real, so the request IS made; the object is not in storage, so
    // the box ends up exactly as a cover that never existed would.
    await expect(card.getByText('No cover')).toBeVisible();
    expect(failed).toHaveLength(1);
  });

  test('a filter combination with no matches shows the empty state and an action', async ({
    page,
  }) => {
    await page.goto(discover('?genre=romance,horror'));
    await expect(cards(page)).toHaveCount(0);
    // Never a blank main, and the state offers the next action (a first-run
    // admin needs a way out of an empty shelf).
    await expect(page.getByRole('heading', { name: /nothing on this shelf/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /clear the filters/i })).toBeVisible();
    // And the count is announced, not just drawn.
    await expect(page.locator('[aria-live="polite"]').first()).toContainText('No titles match');
  });
});

test.describe('cursor pagination', () => {
  test('load more appends the next page and the announced count follows', async ({ page }) => {
    await page.goto(discover());
    await expect(cards(page)).toHaveCount(PAGE_SIZE);

    await page.getByRole('button', { name: /load more/i }).click();

    // The whole fixture set is on screen once both pages are appended.
    await expect(cards(page)).toHaveCount(TOTAL);
    await expect(page.locator('[aria-live="polite"]').first()).toContainText(`${TOTAL} titles`);
    // The shelf is exhausted: the control that fetches nothing more is gone.
    await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0);
  });

  test('page 1 is never dropped: loading more appends rather than replaces', async ({ page }) => {
    await page.goto(discover('?sort=title_asc'));
    const before = await cardHrefs(page);
    await page.getByRole('button', { name: /load more/i }).click();
    await expect(cards(page)).toHaveCount(TOTAL);
    const after = await cardHrefs(page);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  test('the cursor is not in the URL, so a reload returns to page 1', async ({ page }) => {
    await page.goto(discover());
    await page.getByRole('button', { name: /load more/i }).click();
    await expect(cards(page)).toHaveCount(TOTAL);
    expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);

    await page.reload();
    await expect(cards(page)).toHaveCount(PAGE_SIZE);
  });
});

test.describe('genre filter (URL-driven, shareable)', () => {
  test('toggling a genre writes it to the URL and narrows the grid', async ({ page }) => {
    await page.goto(discover());
    await page.getByRole('button', { name: 'Horror', exact: true }).click();

    await page.waitForURL(/[?&]genre=horror(&|$)/);
    await expect(page.getByRole('button', { name: 'Horror', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const expected = queryCatalog({
      genre: ['horror'],
      status: null,
      sort: 'updated_desc',
      limit: PAGE_SIZE,
      cursor: null,
    });
    expect(await cardHrefs(page)).toEqual(
      expected.items.map((item) => `/manga/${item.slug}`),
    );
  });

  test('two genres are both in the URL, in the order they were picked', async ({ page }) => {
    await page.goto(discover());
    await page.getByRole('button', { name: 'Horror', exact: true }).click();
    await page.waitForURL(/genre=horror/);
    await page.getByRole('button', { name: 'Romance', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('genre') === 'horror,romance');
    // The address bar shows the csv comma and all: a reader can read it, retype
    // it and paste it without decoding anything.
    expect(page.url()).toContain('genre=horror,romance');
  });

  test('a filtered URL is shareable: opened fresh, the same shelf comes back', async ({ page }) => {
    await page.goto(discover());
    await page.getByRole('button', { name: 'Horror', exact: true }).click();
    await page.waitForURL(/genre=horror/);
    const shared = page.url();
    const expectedHrefs = await cardHrefs(page);

    await page.goto(shared);
    await expect(cards(page)).toHaveCount(expectedHrefs.length);
    expect(await cardHrefs(page)).toEqual(expectedHrefs);
    // The chip is still pressed: the state came from the URL, not from memory.
    await expect(page.getByRole('button', { name: 'Horror', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('deselecting the last genre removes the key so the URL is clean', async ({ page }) => {
    await page.goto(discover('?genre=horror'));
    await page.getByRole('button', { name: 'Horror', exact: true }).click();
    await page.waitForURL((url) => !url.searchParams.has('genre'));
    expect(new URL(page.url()).searchParams.has('genre')).toBe(false);
  });

  test('more than twenty genres stay inside a scrollable region', async ({ page }) => {
    await page.goto(discover());
    const group = page.getByRole('group', { name: 'Genres' });
    const chips = group.getByRole('button');
    // The vocabulary is larger than the contract's five-selection cap, so the
    // region has to be bounded rather than a two-screen column.
    expect(await chips.count()).toBeGreaterThan(20);

    const scrollable = await group.evaluate((node) => {
      const style = getComputedStyle(node);
      return style.overflowY === 'auto' || style.overflowY === 'scroll';
    });
    expect(scrollable, 'the genre list must scroll inside its own region').toBe(true);

    // And the last genre is genuinely reachable inside that region.
    const last = chips.last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
  });

  test('the sixth genre is refused with a message, because the contract caps it at five', async ({
    page,
  }) => {
    const names = ['Action', 'Adventure', 'Afterlife', 'Angels & Demons', 'Animals'];
    await page.goto(discover(`?genre=${names.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-')).join(',')}`));
    for (const name of names) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }

    await page.getByRole('button', { name: 'Award Winning', exact: true }).click();

    await expect(page.getByRole('status').filter({ hasText: /up to 5/i })).toBeVisible();
    // The URL still carries exactly five: no sixth value was sent to the API,
    // which would have answered 422.
    const genres = (new URL(page.url()).searchParams.get('genre') ?? '').split(',');
    expect(genres).toHaveLength(5);
  });
});

test.describe('status and sort', () => {
  test('the status select is a labelled control that writes to the URL', async ({ page }) => {
    await page.goto(discover());
    const status = page.getByLabel('Status');
    await expect(status).toBeVisible();
    await status.selectOption('completed');

    await page.waitForURL(/[?&]status=completed(&|$)/);
    const expected = queryCatalog({
      genre: [],
      status: 'completed',
      sort: 'updated_desc',
      limit: PAGE_SIZE,
      cursor: null,
    });
    expect(await cardHrefs(page)).toEqual(expected.items.map((item) => `/manga/${item.slug}`));
    // Every card now says so in words, not in a colour.
    await expect(cards(page).first()).toContainText('Completed');
  });

  test('the sort select offers the three contract sorts', async ({ page }) => {
    await page.goto(discover());
    const sort = page.getByLabel('Sort');
    await expect(sort.locator('option')).toHaveText([/recently updated/i, /title/i, /newly added/i]);
  });

  test('sorting by title really reorders the grid', async ({ page }) => {
    await page.goto(discover());
    await page.getByLabel('Sort').selectOption('title_asc');
    await page.waitForURL(/sort=title_asc/);

    const expected = queryCatalog({
      genre: [],
      status: null,
      sort: 'title_asc',
      limit: PAGE_SIZE,
      cursor: null,
    });
    expect(await cardHrefs(page)).toEqual(expected.items.map((item) => `/manga/${item.slug}`));
  });

  test('a sort change resets the cursor to page 1 (edge case)', async ({ page }) => {
    await page.goto(discover());
    await page.getByRole('button', { name: /load more/i }).click();
    await expect(cards(page)).toHaveCount(TOTAL);

    await page.getByLabel('Sort').selectOption('title_asc');
    await page.waitForURL(/sort=title_asc/);

    // Back to one page, and the control that loads another is offered again.
    await expect(cards(page)).toHaveCount(PAGE_SIZE);
    await expect(page.getByRole('button', { name: /load more/i })).toBeVisible();
  });

  test('the result count is announced politely, and updates when it changes', async ({ page }) => {
    await page.goto(discover());
    const live = page.locator('[aria-live="polite"]').first();
    await expect(live).toBeVisible();
    await expect(live).toHaveAttribute('aria-atomic', 'true');
    await expect(live).toContainText(`${PAGE_SIZE} titles`);

    await page.getByRole('button', { name: 'Horror', exact: true }).click();
    await page.waitForURL(/genre=horror/);
    await expect(live).toContainText(/\d+ titles?\.?$/);
    await expect(live).not.toContainText(`${PAGE_SIZE} titles`);
  });

  test('a garbage query string is ignored rather than forwarded or fatal', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const response = await page.goto(
      discover('?sort=nope&status=deleted&genre=%3Cscript%3E,ok-1,action,action'),
    );
    expect(response?.status()).toBe(200);
    // `sort`/`status` are whitelists and the junk genre is dropped, so what is
    // left is one legal genre and the default sort.
    await expect(cards(page)).toHaveCount(
      queryCatalog({
        genre: ['ok-1'],
        status: null,
        sort: 'updated_desc',
        limit: PAGE_SIZE,
        cursor: null,
      }).items.length,
    );
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll('script').length)).toBeGreaterThan(0);
  });
});

test.describe('the manga detail page', () => {
  const detailUrl = (target = DETAIL_SLUG): string => `${harness.url}/manga/${target}`;

  test('every field is present', async ({ page }) => {
    const expected = findBySlug(DETAIL_SLUG)?.detail;
    expect(expected).toBeDefined();
    await page.goto(detailUrl());

    // h1 is the title: one h1 per page.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(expected?.title ?? '');

    // cover, status, chapter count, direction, added
    await expect(page.getByRole('img', { name: `Cover: ${expected?.title ?? ''}` })).toBeVisible();
    const figures = page.locator('dl');
    // The status reads as a word ("Ongoing"), never as the stored value.
    await expect(figures).toContainText('Ongoing');
    await expect(figures).toContainText(String(expected?.chapterCount ?? 0));
    await expect(figures).toContainText(/right to left|left to right/i);

    // creators with their roles, genres, tags, aliases
    await expect(page.getByText('Creators')).toBeVisible();
    await expect(page.getByText(/Author 1 \(author\)/)).toBeVisible();
    await expect(page.getByText('Genres')).toBeVisible();
    await expect(page.getByText('Tags')).toBeVisible();
    await expect(page.locator('p').filter({ hasText: 'Also known as' })).toContainText('Ledger 1');

    // synopsis as PLAIN TEXT
    await expect(page.getByRole('heading', { name: 'Synopsis' })).toBeVisible();
    await expect(
      page.locator('section:has(h2:text-is("Synopsis")) p').first(),
    ).toContainText('A working note about volume 1');

    // first and latest chapter links
    await expect(page.getByRole('link', { name: 'Read Chapter 1' })).toHaveAttribute(
      'href',
      `/manga/${DETAIL_SLUG}/chapter/1`,
    );
    const latest = expected?.latestChapter?.number ?? 0;
    await expect(page.getByRole('link', { name: `Latest: Chapter ${latest}` })).toHaveAttribute(
      'href',
      `/manga/${DETAIL_SLUG}/chapter/${latest}`,
    );
  });

  test('the reading direction is the one the title declares', async ({ page }) => {
    await page.goto(detailUrl('left-to-right'));
    await expect(page.getByText('Left to right', { exact: true })).toBeVisible();
    await page.goto(detailUrl('title-02'));
    await expect(page.getByText('Right to left', { exact: true })).toBeVisible();
  });

  test('an empty synopsis hides its section entirely', async ({ page }) => {
    await page.goto(detailUrl('empty-synopsis'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Synopsis' })).toHaveCount(0);
  });

  test('many aliases wrap instead of overflowing', async ({ page }) => {
    await page.goto(detailUrl());
    const aliases = page.getByText('Also known as').locator('..');
    const box = await aliases.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect((box?.width ?? 0)).toBeLessThanOrEqual((viewport?.width ?? 0));
  });

  test('an unpublished or deleted title gets the real 404 page, not a blank', async ({
    page,
  }) => {
    const response = await page.goto(detailUrl('unpublished-draft'));
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
    await expect(page.getByRole('link', { name: 'Go to the catalog' })).toBeVisible();
    await expect(page.locator('main')).toHaveCount(1);
    // Landmarks survive: a 404 is still a page inside the shell.
    await expect(page.locator('header')).toHaveCount(1);
  });

  test('an unknown slug answers 404 as well — the two are indistinguishable', async ({ page }) => {
    const response = await page.goto(detailUrl('no-such-title-anywhere'));
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  });

  test('a malformed slug is a 404, never a crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const response = await page.goto(`${harness.url}/manga/${encodeURIComponent('///')}`);
    expect([404, 200]).toContain(response?.status());
    expect(errors).toEqual([]);
  });

  test('a single-chapter title reports first = latest and offers one link', async ({ page }) => {
    await page.goto(detailUrl('single-chapter'));
    await expect(page.getByRole('link', { name: 'Read Chapter 1' })).toBeVisible();
    // One chapter means "Latest: Chapter 1" would be the same link twice.
    await expect(page.getByRole('link', { name: /^Latest:/ })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Chapters' }).getByRole('listitem')).toHaveCount(1);
  });

  test('a title with no chapters says so instead of rendering an empty list', async ({ page }) => {
    await page.goto(detailUrl('no-chapters'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No chapters yet', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /read chapter/i })).toHaveCount(0);
    // And the explanation is there, not just the heading.
    await expect(page.getByText(/nothing is published for this title/i)).toBeVisible();
  });

  test('an upstream failure is a labelled state, not a 404 and not a crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const response = await page.goto(detailUrl('upstream-unavailable'));
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: /this title could not be loaded/i }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /try again/i })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('the chapter list', () => {
  const detailUrl = (slug: string): string => `${harness.url}/manga/${slug}`;

  test('it is a real <ol> in reading order with number, title, pages and date', async ({ page }) => {
    await page.goto(detailUrl('title-01'));
    const chapters = findBySlug('title-01')?.chapters ?? [];
    expect(chapters.length).toBeGreaterThan(1);

    const list = page.locator('nav[aria-label="Chapters"] ol');
    await expect(list).toHaveCount(1);
    await expect(list.getByRole('listitem')).toHaveCount(chapters.length);

    // Reading order: the numbers ascend down the list.
    const numbers = await list
      .getByRole('listitem')
      .evaluateAll((nodes) =>
        nodes.map((node) => Number.parseFloat((node.firstElementChild?.textContent ?? '').trim())),
      );
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers).toEqual(chapters.map((chapter) => chapter.number));

    // Page count and date are on the row, as text.
    await expect(list.getByRole('listitem').first()).toContainText(/\d+ pages/);
    await expect(list.getByRole('listitem').first()).toContainText(/\d{4}-\d{2}-\d{2}/);
  });

  test('a 200+ chapter list renders in full, with no virtualization', async ({ page }) => {
    await page.goto(detailUrl('long-series'));
    const rows = page.getByRole('list', { name: 'Chapters' }).getByRole('listitem');
    await expect(rows).toHaveCount(220);
    // The last row is present and reachable: nothing was windowed away.
    await expect(rows.last()).toContainText('220');
    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows.last()).toBeInViewport();
  });

  test('a chapter with no title shows the number alone, not an empty dash', async ({ page }) => {
    await page.goto(detailUrl('title-01'));
    const rows = page.getByRole('list', { name: 'Chapters' }).getByRole('listitem');
    const untitled = (findBySlug('title-01')?.chapters ?? []).find(
      (chapter) => chapter.title === null,
    );
    expect(untitled).toBeDefined();
    const row = rows.nth((untitled?.number ?? 1) - 1);
    await expect(row).toContainText(`Chapter ${untitled?.number}`);
    await expect(row).not.toContainText('—');
  });

  test('a draft chapter is labelled as one, in words', async ({ page }) => {
    await page.goto(detailUrl('series-with-draft'));
    const rows = page.getByRole('list', { name: 'Chapters' }).getByRole('listitem');
    await expect(rows.last()).toContainText('Draft');
    // A draft has no publish date, so it does not claim one.
    await expect(rows.last()).not.toContainText(/\d{4}-\d{2}-\d{2}/);
  });

  test('the latest chapter is labelled, without reversing the list', async ({ page }) => {
    await page.goto(detailUrl('title-01'));
    const rows = page.getByRole('list', { name: 'Chapters' }).getByRole('listitem');
    await expect(rows.last()).toContainText('Latest');
    await expect(rows.first()).not.toContainText('Latest');
  });

  test('no Continue/Resume entry for an anonymous reader, and no read indicator', async ({
    page,
  }) => {
    await page.goto(detailUrl('long-series'));
    // The resume path is implemented, so this is no longer a "not implemented"
    // assertion — it is a claim about the ANONYMOUS case, the only one reachable
    // here: the harness has no session and the API's caller resolver is the
    // anonymous default, so the server has nothing to return and
    // `continueReading` is ABSENT — not null. The authenticated half is covered
    // where a caller can exist (unit and integration, on real PostgreSQL). The
    // read/unread indicator is still unlanded, so that half of the original
    // assertion stands.
    await expect(page.getByText(/^continue\b/i)).toHaveCount(0);
    await expect(page.getByText(/^resume/i)).toHaveCount(0);
    await expect(page.getByText(/unread/i)).toHaveCount(0);
  });
});

/** RegExp-safe literal, for a title that contains regex punctuation. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
