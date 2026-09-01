'use client';

/**
 * SignInForm — the credential form, the states, and the post-login navigation.
 *
 * A client island because the credential exchange is client state, posted as
 * JSON to the login route; the page sanitizes `?next=` on the server so a shared
 * link cannot plant a destination. 401 carries one uniform "invalid
 * credentials" message for both unknown-account and wrong-password, so this form
 * must never render two different messages there; 403 is shown verbatim.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../../../shared/ui/Button';
import { FormField } from '../../../shared/ui/FormField';
import styles from './signin.module.css';

/** The uniform authentication failure: account and password are indistinguishable. */
export const SIGNIN_INVALID_MESSAGE = 'Invalid email or password.';

/** The retryable failure: the exchange itself did not complete. */
export const SIGNIN_RETRY_MESSAGE = 'Sign-in failed. Check your connection and try again.';

export type SignInFormProps = {
  /** The sanitized `?next=` destination — the page, not the island, owns the rule. */
  initialNext: string;
};

type Status = { name: 'idle' } | { name: 'submitting' } | { name: 'error'; message: string };

export function SignInForm({ initialNext }: SignInFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [status, setStatus] = useState<Status>({ name: 'idle' });

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (status.name === 'submitting') return;
    setStatus({ name: 'submitting' });
    let response: Response;
    try {
      response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
    } catch {
      setStatus({ name: 'error', message: SIGNIN_RETRY_MESSAGE });
      return;
    }
    if (response.ok) {
      // `push` alone: an App Router navigation re-renders server components
      // on the new route, which is what picks the fresh session cookie up. A
      // `refresh()` here would race the push and revalidate the sign-in page
      // instead — the shelf would render signed-out on a valid session.
      router.push(initialNext);
      return;
    }
    if (response.status === 401) {
      setStatus({ name: 'error', message: SIGNIN_INVALID_MESSAGE });
      return;
    }
    if (response.status === 403) {
      // The route's deliberate separate answer; shown verbatim (see header).
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: unknown };
      } | null;
      const message = body?.error?.message;
      setStatus({
        name: 'error',
        message: typeof message === 'string' && message !== '' ? message : SIGNIN_INVALID_MESSAGE,
      });
      return;
    }
    setStatus({ name: 'error', message: SIGNIN_RETRY_MESSAGE });
  }

  const busy = status.name === 'submitting';

  return (
    <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
      <FormField
        id="signin-email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <FormField
        id="signin-password"
        label="Password"
        type={revealed ? 'text' : 'password'}
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <label className={styles.reveal} htmlFor="signin-reveal">
        <input
          id="signin-reveal"
          type="checkbox"
          checked={revealed}
          onChange={(event) => setRevealed(event.target.checked)}
        />
        Show password
      </label>
      {status.name === 'error' ? (
        <p className={styles.error} role="alert">
          {status.message}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
