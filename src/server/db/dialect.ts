/**
 * Which database dialect a DSN selects.
 *
 * PGlite is the dev/test fallback: Postgres in-process, no daemon or Docker, but no
 * `pg_trgm` and it takes a directory rather than a network host. The driver, the
 * migrator and the index definitions all need that decision, so it lives here once.
 */

/** DSN prefixes and suffixes that mean "PGlite", not a network Postgres. */
const PGLITE_PREFIXES = ['pglite://', 'file:', 'memory:', '/tmp/', './'] as const;

/**
 * True when the DSN selects the in-process PGlite fallback rather than a real Postgres.
 * An absent DSN is not PGlite: callers decide separately whether it is configured at all.
 */
export function isPgliteDsn(url: string | undefined | null): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed === '') return false;
  return trimmed === ':memory:' || trimmed.endsWith('.db') || PGLITE_PREFIXES.some((p) => trimmed.startsWith(p));
}
