/**
 * `/api/v1` HTTP helpers — the envelope, the headers and the error mapping.
 *
 * Every response goes through {@link jsonResponse} and every failure through
 * {@link failureResponse}, the only caller of `toRouteError`, so a handler
 * cannot forget a header or invent an error code. An unexpected throw gets the
 * generic INTERNAL_ERROR envelope, so a driver message, a DSN or a stack cannot
 * reach a client.
 */
import { AppError, toRouteError } from '../../../shared/contracts/errors';
import type { ErrorCode } from '../../../shared/contracts/errors';
import type { Logger, LogLevel } from '../../../server/telemetry/logger';

/**
 * "catalog/detail APIs: `Cache-Control: private, max-age=60,
 * stale-while-revalidate=60`; private data (library/progress/history/
 * bookmarks): `no-store`". The three endpoints in this tree are all
 * catalog/detail reads, so all three take this value.
 */
export const CATALOG_CACHE_CONTROL = 'private, max-age=60, stale-while-revalidate=60';

/**
 * A request id that cannot be anything but an id. `x-request-id` arrives from
 * a client, and the same value is bound to every log line for the request — a
 * value carrying a newline, a quote or a JSON fragment would forge a log line.
 * This mirrors the guard the logger applies on its side; the route applies it
 * before the value is echoed back.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The request id for one request: the client's, when it is safe, otherwise a
 * fresh v4 UUID.
 *
 * @param request the incoming request
 * @returns a value safe to echo in a header and to bind to every log line
 */
export function requestIdOf(request: Request): string {
  const supplied = request.headers.get('x-request-id');
  if (supplied !== null && SAFE_REQUEST_ID.test(supplied)) return supplied;
  return crypto.randomUUID();
}

/** The JSON content type (JSON only). */
const JSON_TYPE = 'application/json; charset=utf-8';

/**
 * Cache header for any response that is scoped to one reader: the shelf,
 * bookmarks and history are `no-store`; only the public catalog is cacheable.
 * Named here because four route files needed it and a rule copied into four
 * files is the same rule in four places.
 */
export const PRIVATE_CACHE_CONTROL = 'no-store';

export interface JsonOptions {
  /** The `x-request-id` to echo. */
  readonly requestId: string;
  /** Overrides {@link CATALOG_CACHE_CONTROL}; pass `no-store` for private data. */
  readonly cacheControl?: string;
}

/**
 * The single JSON response constructor for this tree.
 *
 * @param body the serialisable payload
 * @param init the status and the headers
 * @returns a Response with the JSON type, the request id and the cache header
 */
export function jsonResponse(body: unknown, init: { status: number } & JsonOptions): Response {
  return new Response(JSON.stringify(body), {
    status: init.status,
    headers: {
      'content-type': JSON_TYPE,
      'cache-control': init.cacheControl ?? CATALOG_CACHE_CONTROL,
      'x-request-id': init.requestId,
    },
  });
}

/**
 * Turns any thrown value into the error envelope.
 *
 * An `AppError` is mapped by the frozen table, so its status, message and
 * alert flag are the normative ones. Anything else is an unhandled failure: it
 * is logged with its cause and answered as `INTERNAL_ERROR` (500) with the
 * generic message — never the thrown object's own text.
 *
 * @param error the thrown value
 * @param requestId echoed into the body so a user can quote it to support
 * @param logger the logging facade
 * @param route the route TEMPLATE (never a real id)
 * @returns the mapped response
 */
export function failureResponse(
  error: unknown,
  requestId: string,
  logger: Logger,
  route: string,
): Response {
  if (error instanceof AppError) {
    const mapped = toRouteError(error, requestId);
    const fields = {
      requestId,
      route,
      code: mapped.body.error.code,
      status: mapped.httpStatus,
      // `alerts` is the alerting signal; a handler that dropped it would make
      // the alerting rule depend on a downstream filter.
      alerts: mapped.alerts,
    };
    logger[levelFor(mapped.logLevel)](
      { ...fields, ...(error.cause === undefined ? {} : { cause: describeCause(error.cause) }) },
      'Request failed.',
    );
    return jsonResponse(mapped.body, { status: mapped.httpStatus, requestId });
  }
  // Not an AppError: a bug or an infrastructure failure. The envelope is
  // generic and the cause never reaches the body.
  logger.error({ requestId, route, cause: describeCause(error) }, 'Unhandled error.');
  const mapped = toRouteError(new AppError('INTERNAL_ERROR', { cause: error }), requestId);
  return jsonResponse(mapped.body, { status: mapped.httpStatus, requestId });
}

function levelFor(level: LogLevel): 'info' | 'warn' | 'error' {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  return 'info';
}

/**
 * A one-line description of an unknown failure for the LOG line only. A DSN is
 * scrubbed: a driver's own message can carry it.
 */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message.replace(/postgres(?:ql)?:\/\/\S+/g, '<dsn>')}`;
  }
  return typeof cause;
}

/**
 * The codes this tree raises, re-exported so a handler cannot typo one.
 */
export type { ErrorCode };

/**
 * A logger that discards everything.
 *
 * It exists for exactly one path: a request that arrives BEFORE the composition
 * root has registered a logger, which on the `/api/v1` tree can only mean the
 * root has not run at all. Failing that request needs a logger-shaped argument
 * and `console` is banned in product code, so the honest options are this or
 * nothing — and a boot-order failure that says so in its own 500 body is more
 * useful than one that says so on stdout and nowhere else.
 *
 * Every line a real request produces goes through the logging facade; this never
 * sees one.
 */
export const SILENT_LOGGER: Logger = {
  level: 'silent',
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  child: () => SILENT_LOGGER,
};
