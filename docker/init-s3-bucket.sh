#!/bin/sh
# Bucket initialisation for the dev compose stack.
#
# It runs the app's own S3 client instead of `mc`/`aws s3api` for three reasons:
# 1. `minio/mc` and `aws/aws-cli` are two more images to pin and pull for a
#    one-line "make the bucket" job.
# 2. `@aws-sdk/client-s3` is already a product dependency (server/storage), so
#    this adds no npm dependency and — more usefully — proves the bucket with the
#    exact client the app will use. A bucket that a different tool can create but
#    the app's client cannot is a real dev trap (protocol equivalence).
# 3. The same image is reused, so there is no second toolchain to keep current.
#
# `forcePathStyle: true` is required for a bare-hostname endpoint (there is no
# `<bucket>.<host>` DNS in a compose network) and must match what
# `server/storage/object-storage.ts` will set when it is implemented. That file
# is a skeleton today, so this script is currently the only place the setting
# exists.
#
# What it does:
#   0. waits for the storage endpoint to accept connections (bounded, 60×2 s),
#   1. HeadBucket → create the bucket only if it is absent (idempotent: a second
#      `up` must not fail),
#   2. put → get → delete a 1-byte canary, which is the same proof /readyz makes
#      later; if the credentials could not write, the bucket existing would prove
#      nothing.
# Exit 0 only when all three steps passed. Never prints a credential.
#
# Usage:
#   docker compose -f docker/docker-compose.dev.yml run --rm minio-init
#   # or, inside a running app container:
#   sh docker/init-s3-bucket.sh
#
# `#!/bin/sh`, not bash: the shipped base is node:24.21.0-alpine, which has
# busybox sh and no bash. The body is POSIX for the same reason.
set -eu

cd "${YOMI_INIT_DIR:-/app}" 2>/dev/null || cd "$(dirname "$0")/.."

program=$(cat <<'YOMI_INIT_EOF'
/**
 * The actual init program. Runs under `node --input-type=module -e`.
 * Configuration comes from the environment only.
 */

const {
  S3_ENDPOINT,
  S3_REGION,
  S3_BUCKET,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
} = process.env;

const say = (line) => console.log(line);

const missing = [
  ['S3_ENDPOINT', S3_ENDPOINT],
  ['S3_REGION', S3_REGION],
  ['S3_BUCKET', S3_BUCKET],
  ['S3_ACCESS_KEY_ID', S3_ACCESS_KEY_ID],
  ['S3_SECRET_ACCESS_KEY', S3_SECRET_ACCESS_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0) {
  // Names only, never values (same redaction rule as
  // shared/validation/env.ts).
  say(`bucket-init REFUSED: missing ${missing.join(', ')}`);
  process.exit(1);
}

const { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
  await import('@aws-sdk/client-s3');

const client = new S3Client({
  region: S3_REGION,
  // Endpoint, not a value from the command line: the endpoint is configuration.
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
});

/** HTTP status of a thrown AWS SDK error, or undefined. */
const statusOf = (error) => error?.$metadata?.httpStatusCode ?? error?.$httpResponse?.statusCode;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the endpoint answers, because `depends_on: service_healthy` on a
 * storage server that has no health endpoint yet would still race the first
 * TCP accept. Bounded so a broken stack fails loudly instead of hanging.
 */
async function waitForEndpoint(attempts = 60, delayMs = 2000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
      return true; // answered — bucket may or may not exist
    } catch (error) {
      const status = statusOf(error);
      // 403/404 means the endpoint is alive and speaking S3: that is a ready
      // endpoint, and the ensure step below decides what to do about the bucket.
      if (status === 403 || status === 404) return true;
      if (attempt === attempts) {
        say(`bucket-init FAILED: ${S3_ENDPOINT} never answered (last error: ${error?.name ?? error})`);
        return false;
      }
      if (attempt === 1 || attempt % 5 === 0) {
        say(`bucket-init: waiting for ${S3_ENDPOINT} (attempt ${attempt}/${attempts})…`);
      }
      await sleep(delayMs);
    }
  }
  return false;
}

async function ensureBucket() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
    say(`bucket-init: bucket "${S3_BUCKET}" already exists at ${S3_ENDPOINT} — nothing to do`);
    return true;
  } catch (error) {
    const status = statusOf(error);
    if (status !== 404 && error?.name !== 'NotFound' && error?.name !== 'NoSuchBucket') {
      say(`bucket-init FAILED: HeadBucket failed with ${error?.name ?? error} (HTTP ${status ?? 'n/a'})`);
      return false;
    }
  }
  try {
    // us-east-1 must NOT carry a LocationConstraint; every other region must.
    await client.send(
      new CreateBucketCommand({
        Bucket: S3_BUCKET,
        ...(S3_REGION === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: S3_REGION } }),
      }),
    );
    say(`bucket-init: created bucket "${S3_BUCKET}" (${S3_REGION}) at ${S3_ENDPOINT}`);
    return true;
  } catch (error) {
    // A concurrent init that won the race is a success, not a failure.
    if (error?.name === 'BucketAlreadyOwnedByYou' || error?.name === 'BucketAlreadyExists') {
      say(`bucket-init: bucket "${S3_BUCKET}" was created concurrently — continuing`);
      return true;
    }
    say(`bucket-init FAILED: CreateBucket failed with ${error?.name ?? error} (HTTP ${statusOf(error) ?? 'n/a'})`);
    return false;
  }
}

/** The 1-byte put/get/delete round trip that /readyz later repeats. */
async function canary() {
  const key = '.yomi-dev-canary';
  const payload = Buffer.from([0x59]); // 'Y'
  try {
    await client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: payload }));
    const got = await client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const bytes = Buffer.from(await got.Body.transformToByteArray());
    if (bytes.length !== 1 || bytes[0] !== payload[0]) {
      say(`bucket-init FAILED: canary round trip returned ${bytes.length} unexpected byte(s)`);
      return false;
    }
    await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    say(`bucket-init: 1-byte canary put/get/delete OK on "${S3_BUCKET}/${key}" (credentials can write)`);
    return true;
  } catch (error) {
    say(`bucket-init FAILED: canary failed with ${error?.name ?? error} (HTTP ${statusOf(error) ?? 'n/a'})`);
    return false;
  }
}

say(`bucket-init: endpoint ${S3_ENDPOINT} region ${S3_REGION} bucket ${S3_BUCKET}`);
if (!(await waitForEndpoint())) process.exit(1);
if (!(await ensureBucket())) process.exit(1);
if (!(await canary())) process.exit(1);
say('bucket-init OK');
process.exit(0);
YOMI_INIT_EOF
)

exec node --input-type=module -e "$program"
