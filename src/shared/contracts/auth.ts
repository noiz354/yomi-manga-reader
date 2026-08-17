/** Auth domain contracts. */
import type { SessionId, UserId } from '../types';

export type UserRole = 'reader' | 'admin';
export type UserStatus = 'active' | 'disabled';

export interface User {
  id: UserId;
  email: string; // citext; lowercased
  displayName: string; // may be ''
  role: UserRole;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * Authentication input (sign-in).
 * Security: `role`/`status` are NOT inputs (forged role fields are ignored;
 * the Zod schema for the public API omits them entirely).
 */
export interface AuthenticationInput {
  email: string;
  password: string;
}

/**
 * Authentication result.
 * Uniformity rule: `rejected` does not distinguish unknown email from wrong
 * password; `disabled` is the single documented exception.
 */
export type AuthenticationResult =
  | { ok: true; session: SessionInfo }
  | { ok: false; reason: 'invalid-credentials' }
  | { ok: false; reason: 'disabled' };

export interface SessionInfo {
  id: SessionId;
  userId: UserId;
  createdAt: string;
  /** Idle expiry (≤ 30 d, sliding). */
  expiresAt: string;
  /** Absolute expiry (≤ 90 d). */
  absoluteExpiresAt: string;
}

/**
 * The frozen caller identity attached by the route guard.
 * This is the ONLY identity source in features.
 */
export interface Caller {
  userId: UserId;
  role: UserRole;
}

/** Optional caller context for public-capable services (catalog detail etc.). */
export type CallerContext = Caller | null;
