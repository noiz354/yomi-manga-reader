#!/usr/bin/env node
// @ts-check
/**
 * Token contrast check — the CI gate for colour tokens.
 *
 * Usage:  node scripts/check-token-contrast.mjs
 * Exit:   0 = every declared pair holds in both themes; 1 = at least one
 *         pair is below its minimum, a colour token is unchecked, or the
 *         checker itself cannot be trusted.
 *
 * `src/shared/ui/tokens.css` is the only place colours are defined, and every
 * colour token there must be covered by a `@contrast` pair or an explicit
 * `@contrast-exempt` line with a written reason. Pairs resolve through
 * `light-dark()`, so one declaration audits both themes.
 *
 * It parses CSS instead of asking a browser: a browser check would see one
 * theme at a time and needs a running app, so it belongs to E2E, not CI's fast
 * lane. Here the palette is static text and the maths is auditable — oklch is
 * converted to sRGB exactly as a browser would, and the conversion is checked
 * against known anchors before any ratio is reported. Alpha colours are
 * rejected rather than measured (a translucent token's contrast depends on what
 * is behind it); an out-of-gamut colour is clipped as a browser clips it and the
 * clip is noted; only `oklch()` and hex are accepted, so a new colour function
 * must be added here first and no token can ship unmeasured.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = join(HERE, '..', 'src', 'shared', 'ui', 'tokens.css');

const THEMES = /** @type {const} */ (['light', 'dark']);
const TEXT_MIN = 4.5; // WCAG 2.1 SC 1.4.3 (Contrast Minimum), AA
const NON_TEXT_MIN = 3; // WCAG 2.1 SC 1.4.11 (Non-text Contrast), AA

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Read a capture group, failing loudly rather than yielding `undefined`.
 * `noUncheckedIndexedAccess` is on, and a silently missing group in a checker
 * is exactly the kind of bug that turns a green build into a false pass.
 * @param {RegExpMatchArray} match
 * @param {number} index
 * @returns {string}
 */
function group(match, index) {
  const value = match[index];
  if (value === undefined) throw new Error(`internal: capture group ${index} is missing`);
  return value;
}

/**
 * oklab → linear sRGB (Björn Ottosson's matrices).
 * @param {number} L @param {number} C @param {number} hueDeg
 * @returns {[number, number, number]}
 */
function oklchToLinearSrgb(L, C, hueDeg) {
  const hue = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** sRGB transfer function, linear → encoded. @param {number} c */
const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** sRGB transfer function, encoded → linear (WCAG works in linear light). @param {number} c */
const decode = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * @typedef {object} Painted
 * @property {number[]} encoded clipped sRGB channels, 0–1
 * @property {boolean} clipped true when the authored colour left the sRGB gamut
 */

/**
 * Parse a colour literal into the sRGB a browser would paint.
 * @param {string} value an `oklch()` or hex literal
 * @param {string} where the token name, for error messages
 * @returns {Painted}
 */
function parseColour(value, where) {
  const text = value.trim();

  if (text.includes('/')) {
    throw new Error(
      `${where}: "${text}" carries an alpha channel. A translucent token's contrast ` +
        `depends on the surface behind it, which this checker cannot know. Use an ` +
        `opaque token, or add a composited pair for this exact stack.`,
    );
  }

  const oklch = text.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i);
  if (oklch) {
    const L = group(oklch, 2) === '%' ? Number(group(oklch, 1)) / 100 : Number(group(oklch, 1));
    const C = Number(group(oklch, 3));
    const hue = Number(group(oklch, 4));
    const encoded = oklchToLinearSrgb(L, C, hue).map(encode);
    return {
      encoded: encoded.map((c) => clamp(c, 0, 1)),
      clipped: encoded.some((c) => c < -0.0005 || c > 1.0005),
    };
  }

  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = group(hex, 1);
    const body = digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits;
    return {
      encoded: [0, 2, 4].map((offset) => Number.parseInt(body.slice(offset, offset + 2), 16) / 255),
      clipped: false,
    };
  }

  throw new Error(
    `${where}: "${text}" is not a colour this checker understands (oklch or hex only). ` +
      `Extend the checker before adding the token, so the token cannot ship unmeasured.`,
  );
}

/** @param {number[]} encoded */
const luminance = (encoded) =>
  0.2126 * decode(encoded[0] ?? 0) +
  0.7152 * decode(encoded[1] ?? 0) +
  0.0722 * decode(encoded[2] ?? 0);

/** @param {number[]} a @param {number[]} b */
function contrastRatio(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** @param {number[]} encoded */
const toHex = (encoded) =>
  '#' +
  encoded
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

/**
 * Split a function's argument list on top-level commas (commas inside nested
 * `oklch(...)` are not separators).
 * @param {string} body the text between a function's parentheses
 * @returns {string[]}
 */
function splitTopLevel(body) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * @param {string} value
 * @param {string} theme
 * @param {string} where
 * @returns {string | null} the colour for this theme, or null if not a colour
 */
function resolveColour(value, theme, where) {
  const trimmed = value.trim();
  const lightDark = trimmed.match(/^light-dark\((.*)\)$/is);
  if (lightDark) {
    const args = splitTopLevel(group(lightDark, 1));
    const pick = args[theme === 'light' ? 0 : 1];
    if (args.length !== 2 || pick === undefined) {
      throw new Error(`${where}: light-dark() takes exactly two colours, found ${args.length}.`);
    }
    return resolveColour(pick, theme, where);
  }
  if (/^(oklch\(|#)/i.test(trimmed)) return trimmed;
  return null;
}

/**
 * Read every custom property declaration in a stylesheet.
 * @param {string} css
 * @returns {Map<string, string>}
 */
function readTokens(css) {
  /** @type {Map<string, string>} */
  const tokens = new Map();
  const declaration = /--([a-z0-9-]+)\s*:/gi;
  let match;
  while ((match = declaration.exec(css)) !== null) {
    let index = match.index + match[0].length;
    let depth = 0;
    let value = '';
    for (; index < css.length; index += 1) {
      const char = css[index];
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
      if (char === ';' && depth === 0) break;
      value += char;
    }
    tokens.set(group(match, 1), value.trim());
  }
  return tokens;
}

/**
 * @typedef {object} Pair
 * @property {string} foreground
 * @property {string} background
 * @property {number} minimum
 * @property {string} why
 */

/** @param {string} css @returns {Pair[]} */
function readPairs(css) {
  /** @type {Pair[]} */
  const pairs = [];
  const line = /@contrast\s+(--[a-z0-9-]+)\s+(--[a-z0-9-]+)\s+([\d.]+)\s+(.+)/gi;
  let match;
  while ((match = line.exec(css)) !== null) {
    pairs.push({
      foreground: group(match, 1),
      background: group(match, 2),
      minimum: Number(group(match, 3)),
      // The pair lives inside a CSS block comment, so the line ends with `*/`.
      why: group(match, 4)
        .replace(/\*\/\s*$/, '')
        .trim(),
    });
  }
  return pairs;
}

/** @param {string} css @returns {Map<string, string>} */
function readExemptions(css) {
  /** @type {Map<string, string>} */
  const exempt = new Map();
  const line = /@contrast-exempt\s+(--[a-z0-9-]+)\s*(.*)/gi;
  let match;
  while ((match = line.exec(css)) !== null) {
    exempt.set(group(match, 1), group(match, 2).trim());
  }
  return exempt;
}

function main() {
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];

  const css = readFileSync(TOKENS_FILE, 'utf8');

  // 0. Trust the maths before trusting a single ratio.
  /** @type {[string, number[]][]} */
  const anchors = [
    ['oklch(1 0 0)', [1, 1, 1]],
    ['oklch(0 0 0)', [0, 0, 0]],
    ['oklch(0.62796 0.25768 29.23)', [1, 0, 0]], // red, to exercise the hue path
  ];
  for (const [literal, expected] of anchors) {
    const got = parseColour(literal, 'self-check').encoded;
    const ok = got.every((c, i) => Math.abs(c - (expected[i] ?? Number.NaN)) < 0.005);
    if (!ok) {
      console.error(
        `FAIL  checker self-check: oklch → sRGB conversion drifted for ${literal} ` +
          `(got ${got.map((c) => c.toFixed(4)).join(', ')}). Every ratio below would ` +
          `be untrustworthy, so nothing is reported.`,
      );
      process.exit(1);
    }
  }

  const tokens = readTokens(css);
  const pairs = readPairs(css);
  const exemptions = readExemptions(css);

  if (pairs.length === 0) {
    console.error('FAIL  no @contrast pairs declared in tokens.css — the audit is empty.');
    process.exit(1);
  }

  // 1. Every colour token must be measured or explicitly exempted.
  const covered = new Set(
    pairs.flatMap((pair) => [pair.foreground, pair.background]).concat([...exemptions.keys()]),
  );
  for (const [name, value] of tokens) {
    const isColour = THEMES.some((theme) => {
      try {
        return resolveColour(value, theme, `--${name}`) !== null;
      } catch {
        return true; // unparseable is the parser's problem, reported below
      }
    });
    if (!isColour) continue;
    if (!covered.has(`--${name}`)) {
      failures.push(
        `--${name} is a colour with no @contrast pair and no @contrast-exempt line. ` +
          `Add the pair it must satisfy, or exempt it with a written reason.`,
      );
    }
  }
  for (const name of exemptions.keys()) {
    if (!tokens.has(name.replace(/^--/, ''))) {
      failures.push(`${name} is exempted but is not defined in tokens.css — stale exemption.`);
    }
    if ((exemptions.get(name) ?? '').length === 0) {
      failures.push(`${name} is exempted with no reason. Every exemption states why.`);
    }
  }

  // 2. Resolve and measure every pair, in both themes.
  /** @type {string[]} */
  const rows = [];
  for (const theme of THEMES) {
    rows.push(`\n  ${theme.toUpperCase()}`);
    rows.push(`  ${'pair'.padEnd(38)}${'ratio'.padStart(7)}  ${'min'.padStart(4)}  verdict`);
    for (const pair of pairs) {
      const fgRaw = tokens.get(pair.foreground.replace(/^--/, ''));
      const bgRaw = tokens.get(pair.background.replace(/^--/, ''));
      if (fgRaw === undefined || bgRaw === undefined) {
        failures.push(
          `${pair.foreground} / ${pair.background}: a pair names a token that does not exist.`,
        );
        continue;
      }
      const fgText = resolveColour(fgRaw, theme, pair.foreground);
      const bgText = resolveColour(bgRaw, theme, pair.background);
      if (fgText === null || bgText === null) {
        failures.push(`${pair.foreground} / ${pair.background}: not a colour in ${theme}.`);
        continue;
      }
      const fg = parseColour(fgText, pair.foreground);
      const bg = parseColour(bgText, pair.background);
      const ratio = contrastRatio(fg.encoded, bg.encoded);
      const ok = ratio >= pair.minimum;
      const label = `${pair.foreground} on ${pair.background}`;
      rows.push(
        `  ${label.padEnd(38)}${ratio.toFixed(2).padStart(7)}  ${pair.minimum
          .toFixed(1)
          .padStart(4)}  ${ok ? 'pass' : 'FAIL'}  ${toHex(fg.encoded)} on ${toHex(bg.encoded)}`,
      );
      if (!ok) {
        failures.push(
          `${label} is ${ratio.toFixed(2)}:1 in the ${theme} theme, below the required ` +
            `${pair.minimum}:1 (${pair.why}).`,
        );
      }
      if (fg.clipped || bg.clipped) {
        notes.push(
          `${label} is outside the sRGB gamut in ${theme}; the ratio above is the ratio ` +
            `of the clipped, painted colour (${toHex(fg.encoded)} on ${toHex(bg.encoded)}).`,
        );
      }
    }
  }

  console.log('Token contrast check — src/shared/ui/tokens.css');
  console.log(
    `\n  ${pairs.length} declared pairs × ${THEMES.length} themes ` +
      `(text floor ${TEXT_MIN}:1, non-text floor ${NON_TEXT_MIN}:1)`,
  );
  console.log(rows.join('\n'));

  for (const note of notes) console.log(`\nnote  ${note}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`\nPASS  every declared pair holds in ${THEMES.join(' and ')}.`);
  process.exit(0);
}

main();
