/**
 * The catalog E2E harness: a fixture API + an origin-preserving reverse proxy.
 * TEST INFRASTRUCTURE, not product code: the pages under test are the real
 * server-rendered pages, only the upstream they read from is answered here.
 * The proxy exists because the pages fetch server-side (so `page.route()` cannot
 * intercept) and a product-code test hook would be fake data; it preserves the
 * `Host` header so the app's own server-side fetch comes back to this harness.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import sharp from 'sharp';
import {
  decodeCursor,
  encodeCursor,
  FAILING_FACETS_MARKER,
  FAILING_SLUG,
  FIXTURE_MANGA,
  findBySlug,
  GENRE_FACETS,
  queryCatalog,
  UNREADABLE_SLUGS,
} from './catalog-fixtures';

export interface HarnessOptions {
  /** The real Next.js server, e.g. `http://127.0.0.1:3200`. */
  appOrigin: string;
  /** 0 (default) picks a free port, so specs can run in parallel. */
  port?: number;
  /**
   * Answer `/api/v1/catalog/facets` with a 503. The genre vocabulary is read on
   * a URL the page builds itself, so a spec cannot fail that one read by adding
   * a query parameter — it needs its own harness. The point is to exercise the
   * page's DEGRADED state: the filter says it could not load and the grid keeps
   * working.
   */
  failFacets?: boolean;
}

export interface CatalogHarness {
  /** The origin the browser must use, and the origin the app will call back. */
  url: string;
  /** Every path the app requested through the harness, in order. */
  readonly requestedPaths: readonly string[];
  close(): Promise<void>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'private, max-age=60, stale-while-revalidate=60',
  });
  res.end(payload);
}

function errorBody(code: string, message: string): unknown {
  return { error: { code, message, requestId: 'e2e-harness' } };
}

/**
 * A real cover image, generated once per asset key and cached. The bytes matter:
 * an LCP or CLS measurement taken against a 1×1 pixel would be a measurement of
 * nothing.
 */
const coverCache = new Map<string, Buffer>();

async function coverBytes(key: string): Promise<Buffer> {
  const cached = coverCache.get(key);
  if (cached !== undefined) return cached;
  const hue = [...key].reduce((total, char) => (total + char.charCodeAt(0)) % 360, 0);
  const png = await sharp({
    create: {
      width: 600,
      height: 900,
      channels: 3,
      background: { r: 60 + (hue % 120), g: 50 + ((hue * 3) % 100), b: 40 + ((hue * 7) % 90) },
    },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  coverCache.set(key, png);
  return png;
}

function parseCatalogQuery(url: URL): {
  genre: string[];
  status: string | null;
  sort: string;
  limit: number;
  cursor: string | null;
} {
  const genre = (url.searchParams.get('genre') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const rawLimit = Number(url.searchParams.get('limit') ?? '24');
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 48) : 24;
  return {
    genre,
    status: url.searchParams.get('status'),
    sort: url.searchParams.get('sort') ?? 'updated_desc',
    limit,
    cursor: url.searchParams.get('cursor'),
  };
}

async function handleApi(
  pathname: string,
  url: URL,
  res: ServerResponse,
  failFacets: boolean,
): Promise<boolean> {
  if (pathname === '/api/v1/catalog') {
    sendJson(res, 200, queryCatalog(parseCatalogQuery(url)));
    return true;
  }

  if (pathname === '/api/v1/catalog/facets') {
    if (failFacets || url.searchParams.has(FAILING_FACETS_MARKER)) {
      sendJson(res, 500, errorBody('INTERNAL_ERROR', 'The facet service is unavailable.'));
      return true;
    }
    sendJson(res, 200, { genres: GENRE_FACETS });
    return true;
  }

  const chapters = pathname.match(/^\/api\/v1\/manga\/([^/]+)\/chapters$/);
  if (chapters?.[1] !== undefined) {
    const slug = decodeURIComponent(chapters[1]);
    if (slug === FAILING_SLUG) {
      sendJson(res, 503, errorBody('INTERNAL_ERROR', 'The chapter service is unavailable.'));
      return true;
    }
    const manga = findBySlug(slug);
    if (manga === undefined || UNREADABLE_SLUGS.has(slug)) {
      sendJson(res, 404, errorBody('MANGA_NOT_FOUND', 'No such manga.'));
      return true;
    }
    sendJson(res, 200, { items: manga.chapters });
    return true;
  }

  const detail = pathname.match(/^\/api\/v1\/manga\/([^/]+)$/);
  if (detail?.[1] !== undefined) {
    const slug = decodeURIComponent(detail[1]);
    if (slug === FAILING_SLUG) {
      sendJson(res, 503, errorBody('INTERNAL_ERROR', 'The catalog is unavailable.'));
      return true;
    }
    const manga = findBySlug(slug);
    if (manga === undefined || UNREADABLE_SLUGS.has(slug)) {
      sendJson(res, 404, errorBody('MANGA_NOT_FOUND', 'No such manga.'));
      return true;
    }
    sendJson(res, 200, manga.detail);
    return true;
  }

  return false;
}

async function handleMedia(pathname: string, res: ServerResponse): Promise<boolean> {
  // Mirrors the delivery grammar (`DELIVERY_KEY_PATTERN`): the base key plus
  // the stored extension. The extension selects nothing here — the fixture has
  // one PNG per cover — it only has to be ACCEPTED the way the route accepts it,
  // or this harness would 404 URLs the product emits.
  const match = pathname.match(/^\/media\/([A-Za-z0-9_-]{6,64})(?:\.(avif|webp|jpeg))?$/);
  if (match === null) return false;
  const key = match[1] ?? '';
  const owner = FIXTURE_MANGA.find((manga) => manga.coverAssetKey === key);
  if (owner === undefined) {
    sendJson(res, 404, errorBody('MEDIA_NOT_FOUND', 'No such asset.'));
    return true;
  }
  const bytes = await coverBytes(key);
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': bytes.length,
    etag: `"${key}"`,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
  return true;
}

function forward(appOrigin: URL, req: IncomingMessage, res: ServerResponse): void {
  const target = new URL(req.url ?? '/', appOrigin);
  const headers = { ...req.headers };
  // Host is intentionally left as the browser sent it: that is what makes the
  // app's server-side fetch address THIS harness instead of the Next server.
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, {
      error: {
        code: 'INTERNAL_ERROR',
        message:
          'The app under test is not reachable. Start it (npm run dev or npm run start) ' +
          'and point E2E_APP_ORIGIN at it.',
        requestId: 'e2e-harness',
      },
    });
  });
  req.pipe(upstream);
}

/** Starts the harness on an ephemeral port (or `options.port`). */
export async function startCatalogHarness(
  options: HarnessOptions,
): Promise<CatalogHarness> {
  const appOrigin = new URL(options.appOrigin);
  const requestedPaths: string[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://harness.invalid');
    requestedPaths.push(url.pathname + url.search);

    void (async () => {
      if (url.pathname.startsWith('/api/')) {
        if (await handleApi(url.pathname, url, res, options.failFacets === true)) return;
        sendJson(res, 404, errorBody('NOT_FOUND', 'No such operation.'));
        return;
      }
      if (await handleMedia(url.pathname, res)) return;
      forward(appOrigin, req, res);
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('harness: the server did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    get requestedPaths() {
      return requestedPaths;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

export { decodeCursor, encodeCursor, FAILING_FACETS_MARKER, FAILING_SLUG };
