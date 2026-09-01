/**
 * Register (`/auth/register`) route shell.
 *
 * Behavior: labeled form (email, password + policy hint via
 * aria-describedby, display name optional); policy errors inline;
 * duplicate email → 409 message; auto-login on success. The `role`
 * field does not exist in this form. No feature code.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Register',
};

export default function RegisterPage() {
  return (
    <>
      <h1>Create an account</h1>
      <NotYetBuilt
        headingId="auth-register-not-built"
        intent="let a reader create an account"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: register form (labeled, policy hints, a11y) */}
    </>
  );
}
