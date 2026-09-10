/**
 * features/uploads — public surface.
 *
 * Depends on: chapters, manga (ports) + infrastructure ports (ObjectStorage,
 * ImageProcessor, AuditSink, TelemetryPort).
 * Used by: web (admin uploads APIs), admin service (re-ingest entry point).
 *
 * The pure core (prepareChapterUpload) is the security-critical unit —
 * unit-tested without any infrastructure.
 */
export * from './prepare-chapter-upload';
export * from './upload-pipeline';
export * from './upload.repository';
