#!/usr/bin/env node
// @ts-check
/**
 * scripts/check-bundle-budget.mjs — the JavaScript budget gate.
 *
 * Budgets are gzipped bytes ("initial reader JS ≤ 250 KB", "whole-page JS ≤
 * 400 KB"), so the built chunks are gzipped with `node:zlib` at level 9 and
 * compared like for like; measuring an uncompressed transfer decided nothing.
 *
 * Turbopack emits no webpack-style per-page chunk map. Two build manifests
 * together give the real set: `.next/build-manifest.json` (`rootMainFiles` +
 * `polyfillFiles`) is the baseline every route ships, and each route's
 * `page_client-reference-manifest.js` supplies its extra chunks. That file is
 * read as TEXT and parsed with a regex — never evaluated — because it is a
 * build artifact.
 *
 * Exit 0 ok · 1 a route is over its budget · 2 the build output is missing or
 * unreadable (a gate that cannot measure must fail, never pass quietly).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT_DIR = join(ROOT, '.next');

/**
 * The declared budgets, in bytes. Repeated here because a build artifact cannot
 * parse a Markdown table; a drift between the two is worth failing on.
 */
const KIB = 1024;
const BUDGETS = [
  {
    // "Initial reader JS ≤ 250 KB gzipped" — the reader is the heaviest route.
    label: 'reader initial JS',
    budget: 250 * KIB,
    route: '/manga/[slug]/chapter/[chapter]',
  },
  { label: '/discover whole-page JS', budget: 400 * KIB, route: '/discover' },
];

/** One line of evidence on stdout. @param {string} message */
function say(message) {
  process.stdout.write(`${message}\n`);
}

/** A measurement that could not be taken. @param {string} problem */
function fail(problem) {
  process.stderr.write(`bundle-budget: ${problem}\n`);
  process.exit(2);
}

/** The chunks every route ships. */
/** @returns {Set<string>} chunk paths under `.next`, as they appear in the manifest */
function baselineChunks() {
  const manifestPath = join(NEXT_DIR, 'build-manifest.json');
  if (!existsSync(manifestPath)) {
    fail(`no build output at ${NEXT_DIR} — run \`npm run build\` first.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = [...(manifest.rootMainFiles ?? []), ...(manifest.polyfillFiles ?? [])];
  if (files.length === 0) {
    fail('build-manifest.json lists no root chunks; refusing to measure a zero-byte page.');
  }
  return new Set(files);
}

/**
 * The extra chunks one route pulls in, from its client-reference manifest.
 * Returns an empty set when the route ships no client modules of its own, which
 * is a legitimate answer (a fully server-rendered route) rather than a failure.
 */
/** @param {string} route route directory under `.next/server/app` @returns {Set<string>} */
function routeChunks(route) {
  const manifestPath = join(NEXT_DIR, 'server', 'app', route, 'page_client-reference-manifest.js');
  if (!existsSync(manifestPath)) {
    fail(`no client-reference manifest for ${route} — the build output is not what this gate expects.`);
  }
  const source = readFileSync(manifestPath, 'utf8');
  // Read as text, never evaluated: this is a build artifact and executing it
  // would make the gate depend on the build's own code.
  const chunks = new Set();
  for (const match of source.matchAll(/"chunks":\[([^\]]*)\]/g)) {
    const list = match[1] ?? '';
    for (const entry of list.matchAll(/"([^"]+\.js)"/g)) {
      const chunk = entry[1] ?? '';
      if (chunk === '') continue;
      // `/_next/static/chunks/x.js` → `static/chunks/x.js`: the `/_next/`
      // PREFIX is stripped, because the chunk lives under `.next/static/`.
      // Substituting `static/` for it here would look for `.next/static/static/`.
      chunks.add(chunk.replace(/^\/_next\//, ''));
    }
  }
  return chunks;
}

/** Gzipped size of one built chunk. */
/** @param {string} relativePath path under `.next` @returns {number} gzipped bytes */
function gzipSizeOf(relativePath) {
  const absolute = join(NEXT_DIR, relativePath);
  if (!existsSync(absolute)) {
    fail(`chunk ${relativePath} is referenced by the manifest but missing from the build.`);
  }
  return gzipSync(readFileSync(absolute), { level: 9 }).length;
}

/** @param {number} bytes @returns {string} */
function kib(bytes) {
  return `${(bytes / KIB).toFixed(1)} KB`;
}

/** @returns {void} */
function main() {
  const baseline = baselineChunks();
  const results = [];
  let over = 0;

  for (const { label, budget, route } of BUDGETS) {
    const chunks = new Set([...baseline, ...routeChunks(route)]);
    let total = 0;
    for (const chunk of chunks) total += gzipSizeOf(chunk);
    const ok = total <= budget;
    if (!ok) over += 1;
    results.push({ label, chunks: chunks.size, total, budget, ok });
  }

  for (const r of results) {
    say(
      `${r.ok ? 'ok  ' : 'OVER'} ${r.label}: ${kib(r.total)} gzipped across ` +
        `${String(r.chunks)} chunks — budget ${kib(r.budget)}` +
        (r.ok ? '' : ` (over by ${kib(r.total - r.budget)})`),
    );
  }

  if (over > 0) {
    process.stderr.write(
        `bundle-budget: ${String(over)} route(s) over budget. Reduce the client bundle, or amend\n` +
        '  the budget with the reason and the new figure — do not raise the budget\n' +
        '  silently, it is the number the product promises its readers.\n',
    );
    process.exit(1);
  }
  say('bundle budget OK: every declared route is inside its budget.');
}

main();
