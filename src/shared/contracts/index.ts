/**
 * shared/contracts — the cross-module vocabulary (leaf layer).
 *
 * Everything here is a TYPE or a PORT (interface) plus the error taxonomy.
 * Behavior (beyond the typed AppError class shape) is NOT implemented here.
 *
 * This layer imports nothing from features/server/app.
 */
export * from './errors';
export * from './manga';
export * from './chapter';
export * from './reader';
export * from './library';
export * from './auth';
export * from './upload';
export * from './search';
export * from './ports';
