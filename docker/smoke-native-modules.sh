#!/bin/sh
# Native-module smoke — sharp round-trip + argon2 hash, on this image.
#
# Why `#!/bin/sh` and not bash: the shipped base is node:24.21.0-alpine, which
# has busybox `sh` and no bash (verified:
# `env: can't execute 'bash': No such file or directory`, exit 127). This file is
# installed into /usr/local/bin and executed directly inside the image, so its
# shebang has to be the one interpreter every target has. The body is POSIX for
# the same reason — no `pipefail`, no `[[ ]]`, no arrays.
#
# Why this is a .sh and not a .mjs: a `.mjs` under `docker/` cannot be linted in
# this repository — the type-aware parser matches it but tsconfig `include` is
# `src`/`tests`/`scripts` only, so it would fail with "was not found by the
# project service". Both files that would have to change are outside this task's
# write scope, so the script is a POSIX shell wrapper that feeds the Node program
# to `node -e`. It is unlinted by design, and stays small enough to read.
#
# What it proves, and why it is not vacuous: `require('sharp')` succeeds as long
# as the JS entry point can be resolved; it does NOT prove the platform binary
# loaded, because sharp defers the `linuxmusl-x64` / `linux-x64` selection to
# first real use. So this script never stops at "imported": it decodes,
# re-encodes and byte-compares an image, and it hashes and verifies a password. A
# base image whose libc does not match the installed prebuilds fails here, not at
# import time. The RED direction was run first, on `node:24.21.0-alpine`:
# `npm ci` fails outright (argon2 has no musl prebuild) and, when the host's glibc
# `node_modules` is forced in, both modules throw on use. Only after that was the
# base image chosen.
#
# Contract:
# - Exit 0  ⇒ both native modules executed real work on this libc.
# - Exit 1  ⇒ at least one module could not be loaded or produced a wrong result;
#             the reason is printed with the module's own message.
# - Never writes a file, never touches the network, never needs credentials. It
#   is safe to run as a CI step and as a compose `exec`.
#
# Usage:
#   # inside the image, with the image's own node_modules (the real proof):
#   docker run --rm --entrypoint yomi-native-smoke yomi-dev:latest
#   # against the compose stack's app container:
#   docker compose -f docker/docker-compose.dev.yml exec app yomi-native-smoke
#   # against the working tree (same program, image-installed modules):
#   docker compose -f docker/docker-compose.dev.yml exec app sh docker/smoke-native-modules.sh
#   # on the host, against the host's node_modules:
#   sh docker/smoke-native-modules.sh
#
# Reproducing the RED direction (why this file is not vacuous), measured
# 2026-09-27. Both probes use the same base as the shipped image and the same
# file; only the dependency install differs. Run from the repo root in a scratch
# directory (they need only package.json + package-lock.json):
#
#   # RED-A: the base image with no dependency stage at all.
#   printf 'FROM node:24.21.0-alpine\nWORKDIR /app\nCOPY docker/smoke-native-modules.sh /app/\n' > Dockerfile.redA
#   docker build -f Dockerfile.redA -t yomi-red-a:probe .   # (context = repo root)
#   docker run --rm --entrypoint /app/smoke-native-modules.sh yomi-red-a:probe
#   # => FAIL sharp: Cannot find package 'sharp' …  / FAIL argon2: Cannot find …
#
#   # RED-B: the "let's slim the image" mistake — install without optional deps.
#   printf 'FROM node:24.21.0-alpine\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci --omit=optional\nCOPY docker/smoke-native-modules.sh /app/\n' > Dockerfile.redB
#   docker build -f Dockerfile.redB -t yomi-red-b:probe .
#   docker run --rm --entrypoint /app/smoke-native-modules.sh yomi-red-b:probe
#   # => FAIL sharp: Could not load the "sharp" module using the linuxmusl-x64
#   #         runtime        (argon2 still passes: its prebuilds are ordinary files,
#   #         not optional deps — so the check is per-module, not a blanket gate)
#
# A third, sharper lesson from RED-B: on musl the failure is deferred. `npm ci`
# exits 0 and `import('sharp')` can even succeed, because the JS entry point
# loads and the platform package is only touched on first real use. That is why
# this script decodes and byte-compares an image instead of checking that the
# module imported.
#
# POSIX `sh` only (see the shebang note): there is no pipeline here, so
# `pipefail` would only narrow portability, and the shipped base has no bash.
set -eu

# Must run where `node_modules/{sharp,argon2}` resolve: the Node module
# resolution base for `--eval` is the current working directory.
cd "${YOMI_SMOKE_DIR:-/app}" 2>/dev/null || cd "$(dirname "$0")/.."

program=$(cat <<'YOMI_SMOKE_EOF'
/**
 * The actual smoke program. Runs under `node --input-type=module -e`.
 * No product source is imported: this proves the *runtime*, not the app.
 */

const failures = [];

/** One aligned line so CI logs stay readable when this is pasted into a PR. */
const say = (line) => console.log(line);
const ok = (line) => say(`  ok    ${line}`);
const bad = (line) => {
  failures.push(line);
  say(`  FAIL  ${line}`);
};

/**
 * libc identity, read from V8's own report. `glibcVersionRuntime` is present on
 * glibc builds and absent on musl builds, which is exactly the distinction
 * that decides whether sharp's / argon2's prebuilds load. Printed so the log
 * states which libc the verdict belongs to.
 */
function describeRuntime() {
  const header = process.report?.getReport?.()?.header ?? {};
  const libc = header.glibcVersionRuntime
    ? `glibc ${header.glibcVersionRuntime}`
    : 'musl (no glibc runtime reported)';
  return { node: process.version, platform: process.platform, arch: process.arch, libc };
}

const runtime = describeRuntime();
say('Yomi native-module smoke — T-FOUND-010 (ADR-005 R3)');
say(`  node   ${runtime.node}   platform ${runtime.platform}/${runtime.arch}   libc ${runtime.libc}`);

// sharp: a real decode → re-encode → byte-compare round trip
// A 32x16 deterministic gradient, so a wrong libc / a stub implementation
// cannot accidentally produce matching bytes.
const WIDTH = 32;
const HEIGHT = 16;
const source = Buffer.alloc(WIDTH * HEIGHT * 3);
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    const i = (y * WIDTH + x) * 3;
    source[i] = x * 8;
    source[i + 1] = y * 16;
    source[i + 2] = (x + y) & 0xff;
  }
}

async function smokeSharp() {
  let sharp;
  try {
    // Dynamic import inside the try: a platform-binary failure is thrown by
    // first *use* in sharp 0.35, and the same guard catches an import failure.
    sharp = (await import('sharp')).default;
  } catch (error) {
    bad(`sharp: import failed — ${error?.message ?? error}`);
    return;
  }
  try {
    const png = await sharp(source, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const meta = await sharp(png).metadata();
    if (meta.format !== 'png') {
      bad(`sharp: decoded format is "${meta.format}", expected "png"`);
      return;
    }
    if (meta.width !== WIDTH || meta.height !== HEIGHT) {
      bad(`sharp: round-tripped dimensions are ${meta.width}x${meta.height}, expected ${WIDTH}x${HEIGHT}`);
      return;
    }
    const decoded = await sharp(png).raw().toBuffer();
    if (decoded.length !== source.length || !decoded.equals(source)) {
      bad(`sharp: raw round trip is not byte-identical (${decoded.length} vs ${source.length} bytes)`);
      return;
    }
    // A second codec proves libvips is really loaded and not only the PNG path.
    const webp = await sharp(png).webp({ quality: 80 }).toBuffer();
    const webpMeta = await sharp(webp).metadata();
    if (webpMeta.format !== 'webp') {
      bad(`sharp: webp re-encode produced format "${webpMeta.format}"`);
      return;
    }
    ok(`sharp ${sharp.versions.vips ? `libvips ${sharp.versions.vips}` : ''} — png round trip ${WIDTH}x${HEIGHT} byte-identical (${png.length} B), webp re-encode ${webp.length} B`);
  } catch (error) {
    bad(`sharp: round trip threw — ${error?.message ?? error}`);
  }
}

// argon2: a real hash + verify + a negative verify
// The password is a literal in this file, not a credential of anything.
async function smokeArgon2() {
  let argon2;
  try {
    argon2 = (await import('argon2')).default;
  } catch (error) {
    bad(`argon2: import failed — ${error?.message ?? error}`);
    return;
  }
  const password = 'yomi-native-smoke-not-a-secret';
  try {
    const options = {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    };
    const hash = await argon2.hash(password, options);
    if (!hash.startsWith('$argon2id$')) {
      bad(`argon2: hash is not argon2id (prefix is not $argon2id$)`);
      return;
    }
    if (!(await argon2.verify(hash, password))) {
      bad('argon2: verify() rejected the password it just hashed');
      return;
    }
    if (await argon2.verify(hash, `${password}-wrong`)) {
      bad('argon2: verify() accepted a wrong password');
      return;
    }
    ok(`argon2id — hash ${hash.slice(0, 30)}… (${hash.length} chars), verify(ok)=true verify(wrong)=false`);
  } catch (error) {
    bad(`argon2: hash/verify threw — ${error?.message ?? error}`);
  }
}

await smokeSharp();
await smokeArgon2();

if (failures.length > 0) {
  say(`NATIVE SMOKE FAILED on ${runtime.libc}: ${failures.length} check(s) failed`);
  process.exit(1);
}
say(`NATIVE SMOKE PASSED on ${runtime.libc} — sharp and argon2 executed real work`);
process.exit(0);
YOMI_SMOKE_EOF
)

exec node --input-type=module -e "$program"
