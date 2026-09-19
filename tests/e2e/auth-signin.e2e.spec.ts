/**
 * E2E — sign in: the seeded reader reaches the member shelf.
 *
 * The E2E journey is register → login → protected → logout; registration does
 * not exist yet, so this file is the sign-in leg of that journey against the
 * seeded reader account.
 *
 * Credentials: the reader is the seed's (`seed-reader@seed.invalid`), but in
 * test mode the seed prefixes every key — emails included — with `t{runId}-`,
 * so the exact address depends on the run that seeded the database under test.
 * Whoever seeds exports the prefix as `SEED_EMAIL_PREFIX` alongside the per-run
 * throwaway `SEED_READER_PASSWORD` (CI's e2e job does both; locally it is the
 * developer's seed invocation). Without the password the whole file skips — a
 * sign-in test with no password to try is not a test. The prefix defaults to ''
 * (a `--env dev` seed prefixes nothing).
 */
import { expect, test, type Page } from '@playwright/test';

const READER_EMAIL = `${process.env['SEED_EMAIL_PREFIX'] ?? ''}seed-reader@seed.invalid`;
const READER_PASSWORD = process.env['SEED_READER_PASSWORD'];

/**
 * Fill that survives hydration. The island's inputs are controlled, so a fill
 * that lands before React takes over is wiped by hydration — and the click
 * that follows becomes a native GET reload (`/auth/signin?`) instead of a
 * credential exchange. Retrying until the value STICKS proves the island is
 * live, which is also what makes the subsequent click deterministic: once a
 * fill sticks, hydration has happened and cannot unhappen.
 */
async function fillWhenHydrated(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label, { exact: true });
  await expect(async () => {
    await field.fill(value);
    await expect(field).toHaveValue(value);
  }).toPass();
}

test.describe('sign in', () => {
  test.skip(
    READER_PASSWORD === undefined || READER_PASSWORD === '',
    'needs SEED_READER_PASSWORD from the environment that seeded the database',
  );

  test('the form is labelled and the shelf link loop closes', async ({ page }) => {
    await page.goto('/auth/signin?next=/library');
    // The island must be hydrated before typing: a fill that lands before
    // React takes over is wiped by hydration, and the click becomes a native
    // GET reload (`/auth/signin?`) instead of a credential exchange.
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // Labelled controls, not placeholders-as-labels.
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await fillWhenHydrated(page, 'Email', READER_EMAIL);
    await fillWhenHydrated(page, 'Password', READER_PASSWORD as string);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // `?next=/library` is honoured, and the shelf — not the signed-out
    // prompt — renders: the session cookie the login route set is picked up
    // server-side after the refresh.
    await expect(page).toHaveURL(/\/library(\?.*)?$/);
    // Either shelf state proves a session: the seeded reader owns nothing,
    // so `#library-empty` is the expected one — but `#library-sort` (a
    // non-empty shelf) must also pass if fixtures ever add entries. What must
    // NOT render is the signed-out prompt.
    await expect(page.locator('#library-empty, #library-sort').first()).toBeVisible();
    await expect(page.locator('#library-signed-out')).toHaveCount(0);
  });

  test('a wrong password gets the uniform message and stays put', async ({ page }) => {
    await page.goto('/auth/signin');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    await fillWhenHydrated(page, 'Email', READER_EMAIL);
    await fillWhenHydrated(page, 'Password', 'wrong-password-000');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The uniform message: account and password failures are
    // indistinguishable, announced, and the page does not navigate. Scoped
    // to the form: Next's own route announcer is also role=alert, so an
    // unscoped lookup resolves to two elements (strict-mode violation).
    await expect(page.locator('form [role="alert"]')).toHaveText('Invalid email or password.');
    await expect(page).toHaveURL(/\/auth\/signin(\?.*)?$/);
    await expect(page.locator('#library-sort')).toHaveCount(0);
  });

  test('an absolute ?next= falls back to the shelf, not off-origin', async ({ page }) => {
    await page.goto('/auth/signin?next=https://evil.example/');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    await fillWhenHydrated(page, 'Email', READER_EMAIL);
    await fillWhenHydrated(page, 'Password', READER_PASSWORD as string);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Signed in anyway (a mangled `next` is never an error), but on-origin:
    // the shelf, not the attacker's page.
    await expect(page).toHaveURL(/\/library(\?.*)?$/);
    expect(new URL(page.url()).origin).not.toContain('evil.example');
    await expect(page.locator('#library-empty, #library-sort').first()).toBeVisible();
    await expect(page.locator('#library-signed-out')).toHaveCount(0);
  });
});
