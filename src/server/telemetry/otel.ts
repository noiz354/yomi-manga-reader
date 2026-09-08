/**
 * server/telemetry — observability initialization (OTel + pino).
 * Traces (W3C context; HTTP/service/DB/STORAGE spans), metrics (OTLP HTTP push), the
 * pino root logger (JSON, redaction, requestId/traceId binding), beacon ingestion and
 * the dashboards/alert-rules files.
 * App code imports @opentelemetry/api only; SDK modules and exporters are imported here
 * only. Exporter failure must never block or crash a request. Labels carry no PII.
 */
export function initTelemetry(/* env: Env */): unknown {
  throw new Error('Not implemented: telemetry init');
}
