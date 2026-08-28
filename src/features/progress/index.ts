/**
 * features/progress — public surface.
 *
 * Depends on nothing (defines its own ports — the DAG root used by reader,
 * catalog and library). Server-side only: the web layer wires the services via
 * composition, and client components use the device-local store plus the
 * progress API rather than importing these server modules.
 */
export * from './reader-progress.repository';
export * from './history.repository';
// The port the catalog service consumes, the pure rules, and the factory the
// composition root wires with the Drizzle reader in
// server/db/repositories/progress.repository.ts.
export * from './resume.service';
