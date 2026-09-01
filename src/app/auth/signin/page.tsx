/**
 * Sign in (`/auth/signin`) route shell.
 *
 * Labeled form (email + password + reveal toggle), inline errors, success
 * redirect, uniform "invalid email or password" message. `?next=` is sanitized
 * HERE, not in the island, so a shared link can never plant an unsurfaced
 * redirect — even a compromised island bundle cannot navigate where the server
 * did not allow; the fallback is the member shelf, never an error. `robots` is
 * intentionally unset.
 */
import type { Metadata } from 'next';
import { SignInForm } from './signin-form';
import { sanitizeNextParam } from './sanitize-next';

export const metadata: Metadata = {
  title: 'Sign in',
};

/** `searchParams` is a promise in Next 16, and `next` may arrive as an array. */
type SearchParams = {
  next?: string | string[];
};

function readNext(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return sanitizeNextParam(undefined);
  return sanitizeNextParam(raw);
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const initialNext = readNext((await searchParams).next);

  return (
    <>
      <h1>Sign in</h1>
      <SignInForm initialNext={initialNext} />
    </>
  );
}
