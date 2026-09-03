/**
 * server/media — ImageProcessorPort implementation (sharp, a PLANNED dependency
 * NOT installed in the architecture phase).
 * Untrusted input: decode (magic-byte validated) → strip ALL metadata → resize
 * downscale-only (max 2560 px) → encode avif/webp/jpeg; covers max 1200 px.
 * Security: dimension guard before heavy memory use, a failed decode rejects,
 * metadata strip is test-verified, 30 s per page, ≤ 4 concurrent decodes.
 */
export function createImageProcessor(): unknown {
  throw new Error('Not implemented: sharp pipeline');
}
