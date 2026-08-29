/**
 * features/auth — AuthService: the authentication domain rules.
 *
 * Registration, sign-in, sign-out, session lifecycle, reset tokens, account
 * deletion cascade ordering. Depends on ports only, never on server/*. Failure
 * responses are uniform: unknown email and wrong password are indistinguishable,
 * timing included; `disabled` is the single documented exception. Identity is
 * never read from request input; `role`/`status` are never non-admin writable.
 */
import type {
  AuthenticationInput,
  AuthenticationResult,
  Caller,
  User,
} from '../../shared/contracts';
import type { UserRepository } from './user.repository';
import type { SessionRepository } from './session';
import type { PasswordHasher } from './password';

export interface AuthService {
  /**
   * Register a new account (role always `reader`).
   * TODO: validate (email, password policy), create user,
   * auto-login (create session). Duplicate email ⇒ AUTH_EMAIL_TAKEN (409).
   * Uniform timing: hash runs even on duplicate.
   */
  register(input: { email: string; password: string; displayName?: string }): Promise<{ user: User; sessionToken: string }>;

  /**
   * Sign in.
   *
   * Edge cases:
   * - unknown email ⇒ dummy Argon2 verify (timing uniformity) ⇒ rejected
   * - disabled account ⇒ rejected 'disabled' (403, documented)
   * - stored hash params < current ⇒ re-hash on success (upgrade path)
   * - rotation: a NEW session per login; previous sessions for the user
   *   remain (multi-device, documented) but the login-time session is
   *   rotation-safe (cookie fixation nullified)
   */
  authenticate(input: AuthenticationInput): Promise<AuthenticationResult>;

  /**
   * Sign out: revoke the given session (immediate — no grace).
   * Idempotent (repeat ⇒ still ok).
   */
  signOut(sessionToken: string): Promise<void>;

  /**
   * Password reset request: ALWAYS 204-shaped (no existence signal);
   * creates a single-use 60-min token (replaces any active token).
   * TODO: mail via MailPort.
   */
  requestPasswordReset(email: string): Promise<void>;

  /**
   * Password reset confirm: validates token (single-use, 60 min), sets new
   * password (policy), revokes ALL user sessions (forced re-login).
   * Uniform error for unknown/expired/used tokens.
   */
  confirmPasswordReset(token: string, newPassword: string): Promise<void>;

  /**
   * Account deletion: explicit cascade (sessions, progress, history, library,
   * bookmarks, prefs, tokens) plus audit provenance — zero residual private
   * rows, test-asserted.
   */
  deleteAccount(caller: Caller): Promise<void>;
}

/**
 * Factory (wired at the composition root with port implementations).
 */
export function createAuthService(deps: {
  users: UserRepository;
  sessions: SessionRepository;
  passwords: PasswordHasher;
}): AuthService {
  throw new Error('Not implemented: auth service wiring');
}
