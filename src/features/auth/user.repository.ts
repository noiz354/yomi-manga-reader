/**
 * UserRepository port: features/auth owns the rules; server/db implements.
 *
 * Invariants:
 * - email is citext (case-insensitive unique).
 * - `create` always yields role 'reader' (no caller can set admin).
 * - lastAdminGuard: demote/disable is refused when the target is the last
 *   active admin (409 ADMIN_LAST_ADMIN) — enforced HERE and in the API.
 */
import type { User, UserRole, UserStatus } from '../../shared/contracts';
import type { UserId } from '../../shared/types';

export interface UserRepository {
  byId(id: UserId): Promise<User | null>;
  byEmail(email: string): Promise<User | null>;

  /** Create (role pinned 'reader'); duplicate email ⇒ typed conflict. */
  create(input: { email: string; displayName: string }): Promise<User>;

  /** Role change (admin-only path; audited by the caller — features/admin). */
  updateRole(id: UserId, role: UserRole): Promise<void>;

  /** Status change; guard: last active admin cannot be disabled/demoted. */
  updateStatus(id: UserId, status: UserStatus): Promise<void>;

  touchLastLogin(id: UserId): Promise<void>;

  /**
   * Deletion cascade list: returns the child rows to delete so the deletion
   * service can drive explicit, logged deletes:
   * sessions, progress, history, library entries, bookmarks, prefs, tokens.
   * (FKs cascade as backstop; the explicit pass is what's test-asserted.)
   */
  listDeletionCascade(id: UserId): Promise<Record<string, string[]>>;

  delete(id: UserId): Promise<void>;
}
