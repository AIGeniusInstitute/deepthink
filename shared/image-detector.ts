/**
 * Detect image MIME type from buffer magic bytes.
 * Canonical source — synced to src/ and container/agent-runner/src/ via make sync-types.
 *
 * Returns the detected MIME type or null if unknown.
 */
export function detectImageMimeTypeStrict(buffer: Buffer): string | null {
  if (buffer.length < 12) {
    return null;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: 47 49 46 38
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if (
    (buffer[0] === 0x49 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x2a &&
      buffer[3] === 0x00) ||
    (buffer[0] === 0x4d &&
      buffer[1] === 0x4d &&
      buffer[2] === 0x00 &&
      buffer[3] === 0x2a)
  ) {
    return 'image/tiff';
  }

  // AVIF: ....ftypavif or ....ftypavis
  if (buffer.length >= 12) {
    const ftyp = buffer.toString('ascii', 4, 8);
    if (ftyp === 'ftyp') {
      const brand = buffer.toString('ascii', 8, 12);
      if (brand === 'avif' || brand === 'avis') {
        return 'image/avif';
      }
    }
  }

  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }

  return null;
}

/**
 * Detect image MIME type from buffer magic bytes with fallback.
 */
export function detectImageMimeType(buffer: Buffer): string {
  return detectImageMimeTypeStrict(buffer) || 'image/jpeg';
}

/**
 * Detect image MIME type from base64 payload (using header bytes only).
 * Returns detected MIME or null if unknown/invalid.
 */
export function detectImageMimeTypeFromBase64Strict(
  base64Data: string,
): string | null {
  try {
    const header = Buffer.from(base64Data.slice(0, 400), 'base64');
    return detectImageMimeTypeStrict(header);
  } catch {
    return null;
  }
}

/**
 * Detect image MIME type from base64 payload with fallback.
 */
export function detectImageMimeTypeFromBase64(base64Data: string): string {
  return detectImageMimeTypeFromBase64Strict(base64Data) || 'image/jpeg';
}
