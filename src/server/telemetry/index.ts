/**
 * server/telemetry — public surface. Used by: composition only.
 * The logger FACADE (redaction-applied) is exported from here so features
 * can log without importing OTel/pino directly.
 * `./redaction` is re-exported with the logger because the redaction contract
 * is part of the same reviewable unit: a caller (or a reviewer) that has the
 * facade can see exactly what it guarantees.
 */
export * from './logger';
export * from './redaction';
export * from './otel';
